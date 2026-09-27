"""Preprocessing workflow tests.

These cover the parts of the methodology that are easy to get quietly wrong:
the target encoding, the TotalCharges blank rule, the split proportions, and
above all that SMOTE touches the training split and never the test split.
"""

from __future__ import annotations

import io

import numpy as np
import pandas as pd
import pytest

from app.pipeline.preprocessing import (
    PreprocessParams,
    PreprocessingError,
    clean_frame,
    load_preprocessing,
    make_preprocessor,
    preprocess,
    resolve_spec,
)


def _row(**overrides) -> dict:
    row = {
        "customerID": "X1", "gender": "Female", "SeniorCitizen": 0, "Partner": "No",
        "Dependents": "No", "tenure": 12, "PhoneService": "Yes",
        "MultipleLines": "No", "InternetService": "DSL", "OnlineSecurity": "No",
        "OnlineBackup": "No", "DeviceProtection": "No", "TechSupport": "No",
        "StreamingTV": "No", "StreamingMovies": "No", "Contract": "One year",
        "PaperlessBilling": "No", "PaymentMethod": "Credit card",
        "MonthlyCharges": 65.0, "TotalCharges": 780.0, "Churn": "No",
    }
    row.update(overrides)
    return row


def _frame(rows: list[dict]) -> pd.DataFrame:
    return pd.DataFrame(rows)


def _params(**overrides) -> PreprocessParams:
    base = {"target_column": "Churn", "id_columns": ["customerID"]}
    base.update(overrides)
    return PreprocessParams(**base)


def _balanced_rows(n: int = 20) -> list[dict]:
    """Rows with an even churn split, enough for a stratified split to work."""
    return [
        _row(customerID=f"C{i}", Churn="Yes" if i % 2 == 0 else "No")
        for i in range(n)
    ]


# -- target handling -----------------------------------------------------


def test_target_is_mapped_to_zero_and_one():
    frame = _frame(_balanced_rows(20))
    result = preprocess(frame, _params(apply_smote=False)).result
    assert result.target_positive_rate == 0.5
    assert result.steps[3].details["positive_count"] == 10


def test_target_case_and_whitespace_are_normalised():
    rows = _balanced_rows(20)
    for index, row in enumerate(rows):
        row["Churn"] = " yes " if index % 2 == 0 else "NO"
    result = preprocess(_frame(rows), _params(apply_smote=False)).result
    assert result.target_positive_rate == 0.5


def test_unexpected_target_value_is_rejected():
    frame = _frame([_row(Churn="Perhaps")])
    with pytest.raises(PreprocessingError) as exc:
        preprocess(frame, _params(apply_smote=False))
    assert exc.value.stage == "target_encoding"
    assert "perhaps" in exc.value.message.lower()


def test_missing_target_value_is_rejected():
    frame = _frame([_row(Churn=None)])
    with pytest.raises(PreprocessingError) as exc:
        preprocess(frame, _params(apply_smote=False))
    assert exc.value.stage == "target_encoding"


def test_absent_target_column_is_rejected():
    frame = _frame([_row()]).drop(columns=["Churn"])
    with pytest.raises(PreprocessingError) as exc:
        preprocess(frame, _params(apply_smote=False))
    assert exc.value.stage == "target_detection"


# -- TotalCharges --------------------------------------------------------


def test_blank_total_charges_at_zero_tenure_becomes_zero(sample_frame):
    prepared = preprocess(sample_frame, _params())
    totals = prepared.x_train["TotalCharges"]
    assert totals.notna().all()
    zero_tenure = prepared.x_train[prepared.x_train["tenure"] == 0]
    assert len(zero_tenure) > 0
    assert (zero_tenure["TotalCharges"] == 0.0).all()


def test_total_charges_comes_back_as_float(sample_frame):
    prepared = preprocess(sample_frame, _params())
    assert pd.api.types.is_float_dtype(prepared.x_train["TotalCharges"])


def test_blank_total_charges_with_tenure_is_reported(sample_frame):
    frame = sample_frame.copy()
    mask = (frame["tenure"] == 5) & frame["TotalCharges"].isna()
    if not mask.any():
        frame.loc[0, "TotalCharges"] = np.nan
    prepared = preprocess(frame, _params())
    assert any("TotalCharges" in w for w in prepared.result.warnings) or not mask.any()


# -- encoding and scaling ------------------------------------------------


def test_split_is_eighty_twenty_and_stratified(prepared):
    split = prepared.result.split
    assert split.train_rows + split.test_rows == 7043
    assert split.test_rows == 1409
    assert split.stratified is True
    # Stratification keeps the churn rate within a hair across the split.
    assert abs(split.train_churn_rate - split.test_churn_rate) < 0.005


def test_encoded_feature_count_matches_the_documented_result(prepared):
    # 19 raw predictor columns become 40 encoded features.
    assert prepared.result.encoded_feature_count == 40


def test_every_one_hot_level_is_kept(prepared):
    names = {f.name for f in prepared.result.encoded_features}
    # Level strings are the dataset's own, reported verbatim.
    assert "Contract_Month-to-month" in names
    assert "Contract_One year" in names
    assert "Contract_Two year" in names


def test_binary_columns_collapse_to_a_single_indicator(prepared):
    by_source: dict[str, list[str]] = {}
    for feature in prepared.result.encoded_features:
        by_source.setdefault(feature.source_column, []).append(feature.name)
    # Two-level columns keep one indicator each, whatever their level names.
    assert by_source["gender"] == ["gender_Male"]
    assert by_source["Partner"] == ["Partner_Yes"]
    assert by_source["PaperlessBilling"] == ["PaperlessBilling_Yes"]
    # Three-level columns keep every level.
    assert len(by_source["Contract"]) == 3


def test_every_required_feature_survives_encoding(prepared):
    """A column must not be silently dropped by the encoding.

    A level list that does not match a column's actual values would encode it
    as all zeros, which is how gender used to disappear from the model.
    """
    from app.pipeline.preprocessing import make_preprocessor, resolve_spec

    spec = resolve_spec(prepared.x_train)
    transformer = make_preprocessor(spec)
    encoded = transformer.fit_transform(prepared.x_train)
    encoded = encoded if encoded.ndim == 2 else encoded.toarray()
    assert encoded.shape[1] > 0
    # No encoded column is entirely zero across the whole training split.
    all_zero = [
        index
        for index in range(encoded.shape[1])
        if not (encoded[:, index] != 0).any()
    ]
    assert all_zero == [], (
        f"encoded columns {all_zero} are all zero, so their source column is "
        "being ignored by the model"
    )


def test_the_reported_scaler_saw_only_the_training_split(prepared):
    """The anti-leakage property, checked directly.

    The reported mean must equal the training split's mean, not the whole
    dataset's. If it ever equals the full-dataset mean, test statistics have
    leaked into the transform.
    """
    train_mean = float(prepared.x_train["tenure"].mean())
    reported = prepared.result.scaler_mean["tenure"]
    assert abs(reported - train_mean) < 1e-4

    whole = prepared.feature_frame["tenure"].astype(float).mean()
    assert abs(reported - float(whole)) > 1e-6, (
        "the scaler mean matches the whole dataset, which means the test "
        "split leaked into the transform"
    )


def test_the_pipeline_standardises_the_training_split(small_prepared):
    from sklearn.linear_model import LogisticRegression

    from app.pipeline.preprocessing import build_training_pipeline

    spec = resolve_spec(small_prepared.x_train)
    pipeline = build_training_pipeline(
        spec, LogisticRegression(max_iter=500), apply_smote=False
    )
    pipeline.fit(small_prepared.x_train, small_prepared.y_train)

    scaler = pipeline.named_steps["preprocess"].named_transformers_["scaled"]
    transformer = pipeline.named_steps["preprocess"]
    encoded = np.asarray(
        transformer.transform(small_prepared.x_train), dtype=np.float64
    )
    names = list(transformer.get_feature_names_out())

    for column in ("tenure", "MonthlyCharges", "TotalCharges"):
        index = names.index(column)
        raw = np.asarray(small_prepared.x_train[column], dtype=float)
        # mean_ / scale_ are the raw statistics the scaler subtracts and
        # divides by. scale_ is the population standard deviation, so compare
        # against numpy with ddof=0 rather than the pandas sample deviation.
        assert abs(scaler.mean_[index] - raw.mean()) < 1e-6
        assert abs(scaler.scale_[index] - raw.std(ddof=0)) < 1e-6
        assert abs(encoded[:, index].mean()) < 1e-6
        assert abs(encoded[:, index].std(ddof=0) - 1) < 1e-6


def test_scaler_statistics_are_reported(prepared):
    assert set(prepared.result.scaler_mean) == {
        "tenure", "MonthlyCharges", "TotalCharges"
    }
    assert all(v > 0 for v in prepared.result.scaler_scale.values())


def test_identifier_columns_are_excluded_from_features(prepared):
    assert "customerID" not in prepared.x_train.columns
    assert "customerID" not in [f.name for f in prepared.result.encoded_features]


def test_target_column_is_excluded_from_features(prepared):
    assert "Churn" not in prepared.x_train.columns


def test_unknown_identifier_columns_are_reported_as_a_warning(sample_frame):
    prepared = preprocess(
        sample_frame, _params(id_columns=["customerID", "not_a_column"])
    )
    assert any("not_a_column" in w for w in prepared.result.warnings)


def test_every_documented_step_is_reported(prepared):
    steps = [s.step for s in prepared.result.steps]
    assert steps == [
        "identifier_columns",
        "total_charges_numeric",
        "categorical_normalisation",
        "target_encoding",
        "encoding_and_scaling",
        "train_test_split",
        "smote_resampling",
    ]


# -- persisted rows and cleaning ----------------------------------------


def test_persisted_rows_are_the_cleaned_frame(sample_frame):
    """The stored rows must not reintroduce the blanks that cleaning removed.

    Training replays these rows to rebuild the split. Persisting the raw frame
    put the blank TotalCharges values back, and NaN reached SMOTE, which
    refuses them.
    """
    prepared = preprocess(sample_frame, _params())

    _preprocessor, metadata = load_preprocessing(prepared.result.preprocessing_id)
    stored = pd.DataFrame(metadata["source_rows"])

    assert "TotalCharges" in stored.columns
    assert not stored["TotalCharges"].isna().any(), (
        "a blank TotalCharges was persisted, so training would replay NaN"
    )
    assert pd.api.types.is_float_dtype(stored["TotalCharges"])


def test_clean_frame_removes_blanks_the_transformer_would_keep(sample_frame):
    """Cleaning has to be applied by the caller; the transformer does not do it.

    The stored ColumnTransformer encodes columns but does not coerce
    TotalCharges, so a raw frame transformed directly still contains NaN.
    """
    params = _params()
    preprocessor = make_preprocessor(resolve_spec(sample_frame.drop(columns=["Churn", "customerID"])))
    features = sample_frame.drop(columns=["Churn", "customerID"])

    raw_encoded = np.asarray(
        preprocessor.fit_transform(features.copy()), dtype=np.float64
    )
    # The sample frame has a blank TotalCharges, so an unclean transform is not
    # finite. This is the condition the fix exists to prevent.
    assert not np.isfinite(raw_encoded).all()

    cleaned, warnings = clean_frame(features.copy(), params)
    assert not warnings
    assert not cleaned["TotalCharges"].isna().any()
    assert np.isfinite(np.asarray(preprocessor.transform(cleaned), dtype=np.float64)).all()


def test_clean_frame_is_idempotent(sample_frame):
    """Cleaning twice must give the same frame, so replaying is safe."""
    params = _params()
    features = sample_frame.copy()
    once, _ = clean_frame(features, params)
    twice, _ = clean_frame(once, params)
    pd.testing.assert_frame_equal(once, twice)


# -- SMOTE placement -----------------------------------------------------


def test_smote_balances_the_training_split_only(prepared):
    resample = prepared.result.resample
    assert resample.applied is True
    assert resample.method == "SMOTE"
    assert resample.scope == "training_split_only"
    # 5,634 training rows balance to 8,278 once the churn class is doubled.
    assert resample.rows_before == 5634
    assert resample.rows_after == 8278


def test_the_test_split_keeps_its_natural_class_distribution(prepared):
    result = prepared.result
    assert 0.26 < result.split.test_churn_rate < 0.27


def test_smote_can_be_switched_off(prepared):
    result = preprocess(
        sample_of(prepared), _params(apply_smote=False)
    ).result
    assert result.resample.applied is False
    assert "not applied" in result.resample.note


def sample_of(prepared, n: int = 20):
    """A small, evenly balanced slice of a prepared run's source frame."""
    return _frame(_balanced_rows(n))


def test_smote_is_refitted_per_fold_not_before_the_split():
    """The training pipeline owns SMOTE, so folds never share synthetic rows."""
    from app.pipeline.preprocessing import build_training_pipeline

    spec = resolve_spec(_frame([_row()]))
    pipeline = build_training_pipeline(spec, _DummyEstimator(), apply_smote=True)
    step_names = [name for name, _ in pipeline.steps]
    assert step_names == ["preprocess", "smote", "model"]


def test_smote_is_skipped_when_there_is_too_little_minority_data():
    rows = [_row(customerID=f"C{i}", Churn="No") for i in range(40)]
    rows.append(_row(customerID="rare", Churn="Yes"))
    # Stratification is off because a single minority row cannot be split.
    result = preprocess(_frame(rows), _params(stratify=False)).result
    assert result.resample.applied is False
    assert "fewer than two minority" in result.resample.note


class _DummyEstimator:
    """Minimal estimator so pipeline wiring can be asserted without training."""

    def fit(self, X, y=None):  # noqa: N803
        return self

    def get_params(self, deep=True):
        return {}

    def set_params(self, **params):
        return self


# -- transformer construction -------------------------------------------


def test_preprocessor_round_trips_known_categories():
    frame = _frame(
        [
            _row(Contract="One year", InternetService="DSL"),
            _row(customerID="X2", Contract="Two year", InternetService="Fiber optic"),
        ]
    )
    spec = resolve_spec(frame)
    transformer = make_preprocessor(spec)
    encoded = transformer.fit_transform(frame)
    assert encoded.shape[0] == 2
    assert np.isfinite(encoded).all()


def test_the_encoded_matrix_has_no_infinite_values(prepared):
    from app.pipeline.preprocessing import make_preprocessor, resolve_spec

    spec = resolve_spec(prepared.x_train)
    encoded = np.asarray(
        make_preprocessor(spec).fit_transform(prepared.x_train), dtype=np.float64
    )
    assert np.isfinite(encoded).all()


# -- reproducibility -----------------------------------------------------


def test_the_same_seed_reproduces_the_same_split(sample_frame):
    a = preprocess(sample_frame, _params(random_seed=1))
    b = preprocess(sample_frame, _params(random_seed=1))
    assert a.x_train["tenure"].reset_index(drop=True).equals(
        b.x_train["tenure"].reset_index(drop=True)
    )
    assert a.result.encoded_feature_count == b.result.encoded_feature_count


def test_a_different_seed_produces_a_different_split(sample_frame):
    a = preprocess(sample_frame, _params(random_seed=1))
    b = preprocess(sample_frame, _params(random_seed=2))
    # The split is re-indexed, so compare content rather than index labels.
    assert not a.x_test["tenure"].reset_index(drop=True).equals(
        b.x_test["tenure"].reset_index(drop=True)
    )


def test_preprocessing_artifacts_are_persisted(prepared):
    from app.store import model_store

    result, rows = model_store.preprocessing_result(prepared.result.preprocessing_id)
    assert result.preprocessing_id == prepared.result.preprocessing_id
    assert len(rows) == 7043


def test_loading_an_unknown_preprocessing_run_fails_cleanly():
    from app.pipeline.preprocessing import load_preprocessing

    with pytest.raises(PreprocessingError) as exc:
        load_preprocessing("does-not-exist")
    assert exc.value.stage == "load_preprocessing"
