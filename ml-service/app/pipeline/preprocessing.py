"""The documented preprocessing workflow.

Implements, in order: TotalCharges numeric conversion with zero-tenure blank
handling, binary encoding, one-hot encoding, standardisation of the three
numeric columns, a stratified 80:20 split, and SMOTE applied to the training
split only.

The fitted transformer is persisted as an artifact so that a model can always
be paired with the exact preprocessing that produced it.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import joblib
import numpy as np
import pandas as pd
from imblearn.over_sampling import SMOTE
from imblearn.pipeline import Pipeline as ImbPipeline
from sklearn.compose import ColumnTransformer
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

from ..config import (
    BINARY_CATEGORICAL_COLUMNS,
    MULTI_CATEGORICAL_COLUMNS,
    SCALED_COLUMNS,
    settings,
)
from ..schemas import (
    EncodedFeature,
    PreprocessParams,
    PreprocessResult,
    PreprocessStepResult,
    ResampleSummary,
    SplitSummary,
)

#: Columns that pass through untouched as numeric predictors.
PASSTHROUGH_NUMERIC = ("SeniorCitizen",)

#: Every column treated as a category, whether binary-encoded or one-hot encoded.
CATEGORICAL_COLUMNS = BINARY_CATEGORICAL_COLUMNS + MULTI_CATEGORICAL_COLUMNS

#: Stands in for an absent categorical value, so it is a level the model can
#: learn from and an explanation can name, rather than an encoder failure.
MISSING_CATEGORY = "Missing"

BINARY_ENCODING = {"yes": 1, "no": 0, "true": 1, "false": 0, "1": 1, "0": 0}


class PreprocessingError(RuntimeError):
    """Raised when preprocessing cannot complete. Carries a stage for the UI."""

    def __init__(self, stage: str, message: str) -> None:
        super().__init__(message)
        self.stage = stage
        self.message = message


@dataclass
class PreparedData:
    """Everything a training run needs, plus the artifacts to reproduce it.

    The train and test matrices are the *raw* feature frames, not the encoded
    ones. Encoding and scaling happen inside the training pipeline so they are
    refitted on each cross-validation fold and on the full training split. That
    keeps test-set statistics out of the scaler, which is the whole point of
    splitting first.
    """

    frame: pd.DataFrame
    feature_frame: pd.DataFrame
    target: pd.Series
    x_train: pd.DataFrame
    x_test: pd.DataFrame
    y_train: np.ndarray
    y_test: np.ndarray
    preprocessor: ColumnTransformer
    result: PreprocessResult
    raw_x_train: pd.DataFrame
    raw_x_test: pd.DataFrame

    @property
    def training_pipeline_features(self) -> pd.DataFrame:
        return self.x_train


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _preprocessor_path(preprocessing_id: str):
    return settings.artifact_dir / "preprocessors" / f"{preprocessing_id}.joblib"


def _metadata_path(preprocessing_id: str):
    return settings.artifact_dir / "preprocessors" / f"{preprocessing_id}.json"


def _coerce_total_charges(
    frame: pd.DataFrame, params: PreprocessParams
) -> tuple[pd.DataFrame, PreprocessStepResult, list[str]]:
    """Convert TotalCharges to numeric and resolve blanks for zero-tenure rows."""
    warnings: list[str] = []
    result = PreprocessStepResult(
        step="total_charges_numeric",
        description=(
            "Convert TotalCharges from text to a numeric type and set blank "
            "values to 0.0 for customers with zero tenure, who have not yet "
            "been billed."
        ),
        affected_columns=["TotalCharges"],
        rows_in=len(frame),
        rows_out=len(frame),
    )

    if "TotalCharges" not in frame.columns:
        raise PreprocessingError(
            "total_charges_numeric",
            "The dataset has no TotalCharges column, which this pipeline requires.",
        )

    working = frame.copy()
    before = working["TotalCharges"]
    numeric = pd.to_numeric(before, errors="coerce")
    blank_mask = numeric.isna()
    blank_count = int(blank_mask.sum())

    details: dict[str, Any] = {
        "original_dtype": str(before.dtype),
        "blank_values_found": blank_count,
        "resulting_dtype": "float64",
    }

    if blank_count:
        if "tenure" in working.columns:
            tenure = pd.to_numeric(working["tenure"], errors="coerce")
            explainable = blank_mask & (tenure == 0)
            unexplained = blank_mask & (tenure != 0)
        else:  # pragma: no cover - tenure is a required column
            explainable = pd.Series(False, index=working.index)
            unexplained = blank_mask

        if params.impute_total_charges_from_zero_tenure:
            numeric = numeric.mask(explainable, 0.0)
        if int(unexplained.sum()) > 0:
            warnings.append(
                f"{int(unexplained.sum())} blank TotalCharges value(s) belong to "
                "customers with non-zero tenure and were left as missing. "
                "Review these rows before relying on the model."
            )
        details["blank_with_zero_tenure"] = int(explainable.sum())
        details["blank_unexplained"] = int(unexplained.sum())
        details["imputed_to_zero"] = bool(params.impute_total_charges_from_zero_tenure)

    still_missing = int(numeric.isna().sum())
    if still_missing:
        # A numeric column with holes cannot be standardised. Impute the median
        # of the observed values and say so, rather than failing silently.
        median = float(numeric.median()) if numeric.notna().any() else 0.0
        numeric = numeric.fillna(median)
        details["remaining_blanks_imputed_with_median"] = still_missing
        details["imputation_median"] = median
        warnings.append(
            f"{still_missing} TotalCharges value(s) could not be explained by "
            f"zero tenure and were imputed with the column median ({median:.2f})."
        )

    working["TotalCharges"] = numeric.astype("float64")
    details["min"] = float(working["TotalCharges"].min())
    details["max"] = float(working["TotalCharges"].max())
    details["mean"] = float(working["TotalCharges"].mean())
    result.details = details
    result.warnings = warnings
    return working, result, warnings


def _normalise_categorical(
    frame: pd.DataFrame,
) -> tuple[pd.DataFrame, list[str]]:
    """Trim categorical values and canonicalise the Yes/No columns.

    The binary encoder pins its categories to exactly ``Yes`` and ``No``, so
    any case or spelling variant of those two has to be folded onto the
    canonical form or the column would encode as all zeros.

    Multi-category columns are only trimmed. Their level strings are the
    dataset's own, and are reported verbatim in SHAP output, so they are left
    alone rather than being restyled.
    """
    working = frame.copy()
    changed: list[str] = []

    yes_no = {"yes": "Yes", "no": "No", "true": "Yes", "false": "No", "y": "Yes", "n": "No"}
    for column in BINARY_CATEGORICAL_COLUMNS:
        if column not in working.columns:
            continue
        series = working[column].astype("string")
        trimmed = series.str.strip()
        canonical = trimmed.str.lower().map(yes_no)
        # Values outside the Yes/No vocabulary are passed through untouched so
        # validation can report them rather than silently mapping them.
        canonical = canonical.where(canonical.notna(), trimmed)
        if not trimmed.equals(canonical):
            changed.append(column)
        working[column] = canonical

    for column in MULTI_CATEGORICAL_COLUMNS:
        if column not in working.columns:
            continue
        series = working[column].astype("string")
        trimmed = series.str.strip()
        if not series.equals(trimmed):
            changed.append(column)
        working[column] = trimmed

    # Missing categorical values become an explicit level rather than NaN.
    #
    # scikit-learn's encoders refuse a column that mixes strings with a missing
    # value, so a dataset with one absent InternetService would otherwise fail
    # with a TypeError from deep inside the encoder. "Missing" is a real category
    # — the service was not supplied — and keeping it visible in the encoded
    # feature names means an explanation can name it.
    for column in CATEGORICAL_COLUMNS:
        if column not in working.columns:
            continue
        series = working[column].astype("string")
        blank = series.isna() | (series.str.strip() == "")
        if int(blank.sum()) > 0:
            changed.append(column)
            working[column] = series.mask(blank, MISSING_CATEGORY)

    return working, sorted(set(changed))


def clean_frame(
    frame: pd.DataFrame, params: PreprocessParams
) -> tuple[pd.DataFrame, list[str]]:
    """Apply the cleaning that must happen before the fitted transformer runs.

    The `TotalCharges` coercion and the categorical normalisation are not part of
    the fitted `ColumnTransformer` — they change the frame's dtypes and values
    rather than encoding columns — so they have to be applied explicitly wherever
    a persisted preprocessor is used.

    Every consumer of a stored preprocessing run goes through here: training when
    it replays the stored rows, prediction when it scores a freshly uploaded
    file, and both explanation endpoints. That is what keeps a new customer
    scored exactly the way the training rows were, and it is why blank
    `TotalCharges` values do not reach SMOTE or the model as NaN.

    Returns the cleaned frame and any warnings raised while cleaning.
    """
    working, _step, warnings = _coerce_total_charges(frame, params)
    working, _changed = _normalise_categorical(working)
    return working, warnings


@dataclass(frozen=True)
class PreprocessorSpec:
    """Which columns each transformer handles, resolved from a dataset."""

    numeric_columns: tuple[str, ...]
    passthrough_columns: tuple[str, ...]
    binary_columns: tuple[str, ...]
    multi_columns: tuple[str, ...]


def resolve_spec(frame: pd.DataFrame) -> PreprocessorSpec:
    """Work out which columns get scaled, passed through, or encoded."""
    return PreprocessorSpec(
        numeric_columns=tuple(
            c for c in SCALED_COLUMNS if c in frame.columns
        ),
        passthrough_columns=tuple(
            c for c in PASSTHROUGH_NUMERIC if c in frame.columns
        ),
        binary_columns=tuple(
            c for c in BINARY_CATEGORICAL_COLUMNS if c in frame.columns
        ),
        multi_columns=tuple(
            c for c in MULTI_CATEGORICAL_COLUMNS if c in frame.columns
        ),
    )


def make_preprocessor(spec: PreprocessorSpec) -> ColumnTransformer:
    """Construct an unfitted column transformer from a resolved spec.

    Returning an unfitted transformer is deliberate: the training pipeline
    clones and refits it inside every cross-validation fold, so no fold is
    scored against a transformer that saw the held-out rows.
    """
    transformers: list[tuple[str, Any, list[str]]] = []
    if spec.numeric_columns:
        transformers.append(
            ("scaled", StandardScaler(), list(spec.numeric_columns))
        )
    if spec.passthrough_columns:
        transformers.append(
            ("passthrough", "passthrough", list(spec.passthrough_columns))
        )
    if spec.binary_columns:
        # Binary columns collapse to a single indicator. The two levels are
        # detected from the data rather than assumed to be Yes/No, because
        # columns like gender hold Male/Female. Pinning levels that a column
        # does not contain would silently encode it as all zeros.
        transformers.append(
            (
                "binary",
                OneHotEncoder(
                    drop="first",
                    handle_unknown="ignore",
                    sparse_output=False,
                ),
                list(spec.binary_columns),
            )
        )
    if spec.multi_columns:
        # Every level is kept. Tree models do not need a reference level, and
        # keeping them preserves the interpretable "Contract: Two year" style
        # feature names the SHAP layer reports.
        transformers.append(
            (
                "onehot",
                OneHotEncoder(
                    handle_unknown="ignore",
                    sparse_output=False,
                ),
                list(spec.multi_columns),
            )
        )

    return ColumnTransformer(
        transformers=transformers,
        remainder="drop",
        verbose_feature_names_out=False,
    )


def _build_preprocessor(
    frame: pd.DataFrame,
) -> tuple[ColumnTransformer, list[EncodedFeature]]:
    """Assemble the column transformer and describe the encoded output."""
    spec = resolve_spec(frame)
    preprocessor = make_preprocessor(spec)
    binary_columns = list(spec.binary_columns)
    multi_columns = list(spec.multi_columns)
    numeric_columns = list(spec.numeric_columns)
    passthrough = list(spec.passthrough_columns)

    features: list[EncodedFeature] = []
    for column in numeric_columns:
        features.append(
            EncodedFeature(
                name=column,
                source_column=column,
                kind="numeric",
                scaled=True,
                label=_numeric_label(column),
            )
        )
    for column in passthrough:
        features.append(
            EncodedFeature(
                name=column,
                source_column=column,
                kind="numeric",
                scaled=False,
                label=column.replace("_", " "),
            )
        )
    for column in binary_columns:
        # Two levels, sorted, with the first dropped as the reference level.
        # The surviving level names the indicator column.
        levels = sorted(str(v) for v in frame[column].dropna().unique().tolist())
        if len(levels) < 2:
            # A single-valued column has nothing to contrast. Report it as an
            # all-zero indicator rather than inventing a second level.
            level = levels[0] if levels else "value"
            features.append(
                EncodedFeature(
                    name=f"{column}_{level}",
                    source_column=column,
                    kind="binary",
                    level=level,
                    scaled=False,
                    label=f"{column}: {level}",
                )
            )
            continue
        level = levels[-1]
        features.append(
            EncodedFeature(
                name=f"{column}_{level}",
                source_column=column,
                kind="binary",
                level=level,
                scaled=False,
                label=f"{_humanise(column)}: {level}",
            )
        )
    for column in multi_columns:
        levels = sorted(
            str(v)
            for v in frame[column].dropna().unique().tolist()
        )
        for level in levels:
            features.append(
                EncodedFeature(
                    name=f"{column}_{level}",
                    source_column=column,
                    kind="onehot",
                    level=level,
                    scaled=False,
                    label=f"{_humanise(column)}: {level}",
                )
            )

    return preprocessor, features


def _humanise(column: str) -> str:
    """Turn a column name into readable words for a label."""
    return column.replace("_", " ")


def _numeric_label(column: str) -> str:
    return {
        "tenure": "Tenure (months)",
        "MonthlyCharges": "Monthly charges",
        "TotalCharges": "Total charges",
    }.get(column, column.replace("_", " "))


def preprocess(
    frame: pd.DataFrame,
    params: PreprocessParams,
    *,
    source_filename: str = "dataset.csv",
) -> PreparedData:
    """Run the full documented preprocessing workflow over a raw DataFrame."""
    preprocessing_id = uuid.uuid4().hex
    created_at = _utcnow()
    steps: list[PreprocessStepResult] = []
    all_warnings: list[str] = []

    target_column = params.target_column
    if target_column not in frame.columns:
        raise PreprocessingError(
            "target_detection",
            f"Target column '{target_column}' is not present in the dataset.",
        )

    id_columns = [c for c in params.id_columns if c in frame.columns]
    missing_ids = [c for c in params.id_columns if c not in frame.columns]
    if missing_ids:
        all_warnings.append(
            "Identifier column(s) not found in the dataset and ignored: "
            + ", ".join(missing_ids)
        )

    rows_in = len(frame)

    # Step 1 - identifier columns are carried alongside, not modelled on.
    if id_columns:
        steps.append(
            PreprocessStepResult(
                step="identifier_columns",
                description=(
                    "Identifier columns are kept for traceability and excluded "
                    "from model training."
                ),
                affected_columns=id_columns,
                rows_in=rows_in,
                rows_out=rows_in,
                details={"excluded_from_features": True},
            )
        )

    # Step 2 - TotalCharges
    working, charge_step, charge_warnings = _coerce_total_charges(frame, params)
    steps.append(charge_step)
    all_warnings.extend(charge_warnings)

    # Step 3 - categorical normalisation
    working, changed_columns = _normalise_categorical(working)
    steps.append(
        PreprocessStepResult(
            step="categorical_normalisation",
            description=(
                "Trim whitespace from categorical values and fold spelling "
                "variants of Yes and No onto a single canonical form, so "
                "encoding is not case-sensitive."
            ),
            affected_columns=changed_columns,
            rows_in=rows_in,
            rows_out=rows_in,
            details={"columns_normalised": changed_columns},
        )
    )

    # Step 4 - target encoding
    target_raw = working[target_column].astype("string").str.strip().str.lower()
    unknown = sorted(set(target_raw.dropna().unique()) - {"yes", "no"})
    if unknown:
        raise PreprocessingError(
            "target_encoding",
            "The target column contains values other than Yes/No: "
            + ", ".join(unknown),
        )
    if target_raw.isna().any():
        raise PreprocessingError(
            "target_encoding",
            "The target column contains missing values. Every row must state "
            "whether the customer churned.",
        )
    y = target_raw.map({"no": 0, "yes": 1}).astype("int64")
    steps.append(
        PreprocessStepResult(
            step="target_encoding",
            description="Map the churn label to 0 for No and 1 for Yes.",
            affected_columns=[target_column],
            rows_in=rows_in,
            rows_out=rows_in,
            details={
                "positive_rate": round(float(y.mean()), 6),
                "positive_count": int(y.sum()),
            },
        )
    )

    feature_frame = working.drop(columns=[target_column])
    for column in id_columns:
        feature_frame = feature_frame.drop(columns=[column])

    # Step 5 - stratified split, taken on the raw features.
    #
    # The split happens before any fitting. The transformer is fitted later,
    # inside the training pipeline, on the training portion only, so the
    # scaler's mean and standard deviation never see a test row.
    stratify_target = y if params.stratify else None
    x_train, x_test, y_train, y_test = train_test_split(
        feature_frame,
        y.to_numpy(),
        test_size=params.test_size,
        random_state=params.random_seed,
        stratify=stratify_target,
    )
    x_train = x_train.reset_index(drop=True)
    x_test = x_test.reset_index(drop=True)

    # Step 6 - encoding and scaling, fitted on the training split only, purely
    # to report the resulting schema and the scaler that training will produce.
    preprocessor, encoded_features = _build_preprocessor(x_train)
    try:
        encoded_train = preprocessor.fit_transform(x_train)
    except ValueError as exc:
        raise PreprocessingError(
            "encoding", f"Encoding the categorical columns failed: {exc}"
        ) from exc

    if not np.isfinite(encoded_train).all():
        raise PreprocessingError(
            "scaling",
            "The encoded feature matrix contains values that are not finite. "
            "Check for missing or infinite numbers in the numeric columns.",
        )

    # The reported encoded-feature list must cover levels that only appear in
    # the test split, or a prediction on unseen data would report a feature the
    # schema does not describe.
    preprocessor_full, encoded_features = _build_preprocessor(feature_frame)
    try:
        preprocessor_full.fit_transform(feature_frame)
    except ValueError:  # pragma: no cover - already validated on the train split
        pass

    spec = resolve_spec(x_train)
    steps.append(
        PreprocessStepResult(
            step="encoding_and_scaling",
            description=(
                "Binary-encode the two-category columns, one-hot encode the "
                "multi-category columns keeping every level, and standardise "
                "tenure, MonthlyCharges and TotalCharges. The transformer is "
                "fitted inside the training pipeline, so it is refitted on each "
                "cross-validation fold and never sees the test split."
            ),
            affected_columns=[f.name for f in encoded_features],
            rows_in=rows_in,
            rows_out=rows_in,
            details={
                "binary_encoded": list(spec.binary_columns),
                "one_hot_encoded": list(spec.multi_columns),
                "standardised": list(spec.numeric_columns),
                "predictor_columns_before": int(feature_frame.shape[1]),
                "encoded_feature_count": int(encoded_train.shape[1]),
                "fitted_on": "training split only",
            },
        )
    )

    train_churners = int(np.sum(y_train))
    test_churners = int(np.sum(y_test))
    split = SplitSummary(
        train_rows=int(x_train.shape[0]),
        test_rows=int(x_test.shape[0]),
        train_churners=train_churners,
        test_churners=test_churners,
        train_churn_rate=round(train_churners / max(x_train.shape[0], 1), 6),
        test_churn_rate=round(test_churners / max(x_test.shape[0], 1), 6),
        stratified=params.stratify,
        random_seed=params.random_seed,
    )
    steps.append(
        PreprocessStepResult(
            step="train_test_split",
            description=(
                f"Split the dataset {int((1 - params.test_size) * 100)}:"
                f"{int(params.test_size * 100)}"
                + (", stratified on the churn target" if params.stratify else "")
                + "."
            ),
            affected_columns=[],
            rows_in=rows_in,
            rows_out=int(x_train.shape[0] + x_test.shape[0]),
            details=split.model_dump(),
        )
    )

    if split.train_churn_rate and split.test_churn_rate:
        drift = abs(split.train_churn_rate - split.test_churn_rate)
        if drift > 0.01:
            all_warnings.append(
                f"The churn rate differs by {drift:.1%} between the training and "
                "test splits. Stratification may not have been applied."
            )

    # Step 7 - SMOTE configuration, measured on the training split.
    #
    # The resampled rows are measured here so the interface can report real
    # before/after counts, then discarded. The rows actually used for training
    # are resampled inside the pipeline, once per cross-validation fold, so no
    # synthetic row can cross a fold boundary.
    resample = ResampleSummary(
        applied=False,
        method=None,
        scope="training_split_only",
        rows_before=int(x_train.shape[0]),
        rows_after=int(x_train.shape[0]),
        minority_before=min(train_churners, int(x_train.shape[0]) - train_churners),
        minority_after=min(train_churners, int(x_train.shape[0]) - train_churners),
        note=(
            "SMOTE was not applied. The training split keeps its natural class "
            "proportions, so evaluation reflects real-world prevalence."
        ),
    )

    if params.apply_smote:
        minority = min(train_churners, int(x_train.shape[0]) - train_churners)
        if minority < 2:
            resample.note = (
                "SMOTE was skipped because the training split has fewer than two "
                "minority-class rows."
            )
            all_warnings.append(resample.note)
        else:
            try:
                probe_encoder = make_preprocessor(spec)
                probe = probe_encoder.fit_transform(x_train)
                sampler = SMOTE(random_state=params.smote_random_state)
                resampled, resampled_labels = sampler.fit_resample(probe, y_train)
                majority = max(
                    int(np.sum(resampled_labels == 0)),
                    int(np.sum(resampled_labels == 1)),
                )
                resample = ResampleSummary(
                    applied=True,
                    method="SMOTE",
                    scope="training_split_only",
                    rows_before=int(x_train.shape[0]),
                    rows_after=int(resampled.shape[0]),
                    minority_before=minority,
                    minority_after=majority,
                    note=(
                        "SMOTE is applied inside the training pipeline and "
                        "refitted on each cross-validation fold, so no "
                        "synthetic row crosses a fold boundary. The counts "
                        "here are what it produces on the full training split. "
                        "The test split is never resampled, so evaluation "
                        "reflects the real class distribution."
                    ),
                )
            except ValueError as exc:
                raise PreprocessingError(
                    "smote",
                    f"SMOTE could not be applied to the training split: {exc}",
                ) from exc

    steps.append(
        PreprocessStepResult(
            step="smote_resampling",
            description=(
                "Apply SMOTE to the training split to balance the churn class, "
                "refitted inside every cross-validation fold. The test split "
                "is never resampled."
            )
            if params.apply_smote
            else "Skip SMOTE and keep the natural class distribution.",
            affected_columns=[],
            rows_in=int(x_train.shape[0]),
            rows_out=resample.rows_after or int(x_train.shape[0]),
            details=resample.model_dump(),
        )
    )

    scaler_mean: dict[str, float] = {}
    scaler_scale: dict[str, float] = {}
    scaler = preprocessor.named_transformers_.get("scaled")
    if scaler is not None and hasattr(scaler, "mean_"):
        for column, mean, scale in zip(
            list(spec.numeric_columns), scaler.mean_, scaler.scale_
        ):
            scaler_mean[column] = round(float(mean), 6)
            scaler_scale[column] = round(float(scale), 6)

    result = PreprocessResult(
        preprocessing_id=preprocessing_id,
        created_at=created_at,
        params=params,
        source_row_count=rows_in,
        source_column_count=int(len(frame.columns)),
        target_column=target_column,
        target_positive_rate=round(float(y.mean()), 6),
        steps=steps,
        split=split,
        resample=resample,
        encoded_features=encoded_features,
        encoded_feature_count=int(encoded_train.shape[1]),
        warnings=all_warnings,
        scaler_mean=scaler_mean,
        scaler_scale=scaler_scale,
    )

    # The cleaned frame is persisted, not the raw one. Training replays these
    # rows to rebuild the split, and the TotalCharges coercion happens in
    # `working` rather than inside the fitted transformer, so persisting the raw
    # frame would reintroduce the blank values and leave NaN in the matrix that
    # SMOTE is asked to resample.
    cleaned = working.copy()
    _persist(preprocessing_id, preprocessor, result, source_filename, cleaned)

    return PreparedData(
        frame=cleaned,
        feature_frame=feature_frame,
        target=y,
        x_train=x_train,
        x_test=x_test,
        y_train=np.asarray(y_train, dtype=np.int64),
        y_test=np.asarray(y_test, dtype=np.int64),
        preprocessor=preprocessor,
        result=result,
        raw_x_train=x_train,
        raw_x_test=x_test,
    )


def _persist(
    preprocessing_id: str,
    preprocessor: ColumnTransformer,
    result: PreprocessResult,
    source_filename: str,
    frame: pd.DataFrame,
) -> None:
    """Store the fitted transformer, its metadata, and the exact source rows.

    Persisting the source rows is what makes a prediction reproducible: the
    model is always paired with the precise customer records it was fitted on.
    """
    settings.artifact_dir.mkdir(parents=True, exist_ok=True)
    (settings.artifact_dir / "preprocessors").mkdir(parents=True, exist_ok=True)

    joblib.dump(preprocessor, _preprocessor_path(preprocessing_id))
    digest = hashlib.sha256(
        frame.to_csv(index=False).encode("utf-8")
    ).hexdigest()
    metadata = result.model_dump(mode="json")
    metadata["source_filename"] = source_filename
    metadata["source_sha256"] = digest
    metadata["source_rows"] = frame.to_dict(orient="records")
    _metadata_path(preprocessing_id).write_text(
        json.dumps(metadata, default=str), encoding="utf-8"
    )


def load_preprocessing(preprocessing_id: str) -> tuple[ColumnTransformer, dict[str, Any]]:
    """Reload a persisted preprocessing run by id."""
    meta_file = _metadata_path(preprocessing_id)
    pre_file = _preprocessor_path(preprocessing_id)
    if not meta_file.exists() or not pre_file.exists():
        raise PreprocessingError(
            "load_preprocessing",
            f"Preprocessing run '{preprocessing_id}' was not found. Run "
            "preprocessing again before training.",
        )
    metadata = json.loads(meta_file.read_text(encoding="utf-8"))
    preprocessor: ColumnTransformer = joblib.load(pre_file)
    return preprocessor, metadata


def encoded_feature_names(preprocessor: ColumnTransformer) -> list[str]:
    """Model input column names in the order the pipeline produces them."""
    try:
        names = list(preprocessor.get_feature_names_out())
    except Exception:  # pragma: no cover - defensive
        return []
    cleaned: list[str] = []
    for name in names:
        cleaned.append(str(name).split("__", 1)[-1])
    return cleaned


def build_training_pipeline(
    spec: PreprocessorSpec,
    estimator: Any,
    *,
    apply_smote: bool = True,
    smote_random_state: int = 42,
) -> ImbPipeline:
    """Wrap an estimator with encoding, scaling and SMOTE.

    Using imblearn's Pipeline means GridSearchCV refits the transformer and
    SMOTE inside every cross-validation fold, so no synthetic row and no
    test-set statistic can cross the validation boundary.
    """
    steps: list[tuple[str, Any]] = [("preprocess", make_preprocessor(spec))]
    if apply_smote:
        steps.append(("smote", SMOTE(random_state=smote_random_state)))
    steps.append(("model", estimator))
    return ImbPipeline(steps=steps)
