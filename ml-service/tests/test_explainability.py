"""SHAP explanation tests.

The central claims these tests defend: contributions are real, they are
reconstructible against the model's own probability, and the language used to
describe them never claims causation.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.pipeline.explainability import (
    RISK_INCREASE_SENTENCE,
    RISK_REDUCE_SENTENCE,
    background_sample,
    describe_capability,
    describe_value,
    global_explanation,
    local_explanation,
)
from app.pipeline.training import train_single_model

CAUSAL_WORDS = ("caused", "causes", "will cause", "guarantees", "guarantee")


@pytest.fixture(scope="module")
def trained_xgboost(small_prepared):
    return train_single_model(
        small_prepared,
        "xgboost",
        preprocessing_id=small_prepared.result.preprocessing_id,
        cv_folds=3,
        random_seed=42,
    )


@pytest.fixture(scope="module")
def encoded_test(small_prepared, trained_xgboost):
    transformer = trained_xgboost.pipeline.named_steps["preprocess"]
    return np.asarray(
        transformer.transform(small_prepared.x_test), dtype=np.float64
    )


def _explain(small_prepared, trained, encoded, index: int):
    features = small_prepared.result.encoded_features
    names = [f.name for f in features]
    background = background_sample(encoded, size=min(50, encoded.shape[0]))
    return local_explanation(
        model_type=trained.model_type,
        pipeline=trained.pipeline,
        encoded_row=encoded[index].reshape(1, -1),
        features=features,
        feature_names=names,
        background=background,
        model_id="test-model",
        model_version=trained.version,
        row_index=index,
    )


# -- capability ----------------------------------------------------------


def test_tree_models_declare_treeshap():
    capability = describe_capability("xgboost")
    assert capability.explainer == "TreeSHAP"
    assert capability.exact is True


def test_logistic_regression_declares_linear_shap():
    capability = describe_capability("logistic_regression")
    assert "Linear" in capability.explainer
    assert capability.exact is True


# -- background sampling -------------------------------------------------


def test_background_sample_is_bounded_and_deterministic():
    matrix = np.arange(500 * 4, dtype=float).reshape(500, 4)
    a = background_sample(matrix, size=50, seed=1)
    b = background_sample(matrix, size=50, seed=1)
    assert a.shape == (50, 4)
    assert np.array_equal(a, b)


def test_background_sample_returns_everything_when_the_input_is_small():
    matrix = np.arange(10 * 3, dtype=float).reshape(10, 3)
    assert background_sample(matrix, size=100).shape == (10, 3)


def test_background_sample_rejects_an_empty_matrix():
    from app.pipeline.preprocessing import PreprocessingError

    with pytest.raises(PreprocessingError):
        background_sample(np.zeros((0, 3)))


# -- local explanations --------------------------------------------------


def test_local_explanation_reconstructs_the_prediction(
    small_prepared, trained_xgboost, encoded_test
):
    """Tree models explain in probability units, so contributions add directly."""
    for index in (0, 5, 17):
        explanation = _explain(small_prepared, trained_xgboost, encoded_test, index)
        rebuilt = explanation.base_value + sum(
            c.shap_value for c in explanation.all_contributions
        )
        assert rebuilt == pytest.approx(explanation.churn_probability, abs=0.02), (
            "SHAP contributions must add up to the prediction the model made"
        )
        assert "do not fully reconstruct" not in explanation.summary


def test_local_explanation_matches_the_models_own_probability(
    small_prepared, trained_xgboost, encoded_test
):
    index = 3
    explanation = _explain(small_prepared, trained_xgboost, encoded_test, index)
    expected = float(
        trained_xgboost.estimator.predict_proba(
            encoded_test[index].reshape(1, -1)
        )[0, 1]
    )
    assert explanation.churn_probability == pytest.approx(expected, abs=1e-6)


def test_contributions_cover_every_feature_exactly_once(
    small_prepared, trained_xgboost, encoded_test
):
    explanation = _explain(small_prepared, trained_xgboost, encoded_test, 0)
    features = small_prepared.result.encoded_features
    assert len(explanation.all_contributions) == len(features)
    names = [c.feature for c in explanation.all_contributions]
    assert len(set(names)) == len(names)


def test_contributions_are_ordered_by_absolute_size(
    small_prepared, trained_xgboost, encoded_test
):
    explanation = _explain(small_prepared, trained_xgboost, encoded_test, 0)
    magnitudes = [abs(c.shap_value) for c in explanation.all_contributions]
    assert magnitudes == sorted(magnitudes, reverse=True)


def test_increasing_and_reducing_factors_are_separated(
    small_prepared, trained_xgboost, encoded_test
):
    explanation = _explain(small_prepared, trained_xgboost, encoded_test, 0)
    assert all(c.shap_value > 0 for c in explanation.top_increasing_risk)
    assert all(c.shap_value < 0 for c in explanation.top_reducing_risk)
    assert all(
        c.direction == "increases_risk" for c in explanation.top_increasing_risk
    )
    assert all(c.direction == "reduces_risk" for c in explanation.top_reducing_risk)


def test_top_lists_respect_the_requested_limit(
    small_prepared, trained_xgboost, encoded_test
):
    features = small_prepared.result.encoded_features
    background = background_sample(encoded_test, size=40)
    explanation = local_explanation(
        model_type=trained_xgboost.model_type,
        pipeline=trained_xgboost.pipeline,
        encoded_row=encoded_test[0].reshape(1, -1),
        features=features,
        feature_names=[f.name for f in features],
        background=background,
        model_id="m",
        model_version="v",
        top_n=3,
    )
    assert len(explanation.top_increasing_risk) <= 3
    assert len(explanation.top_reducing_risk) <= 3


def test_explanation_language_never_claims_causation(
    small_prepared, trained_xgboost, encoded_test
):
    for index in (0, 9, 21):
        explanation = _explain(small_prepared, trained_xgboost, encoded_test, index)
        text = " ".join(
            [explanation.summary, explanation.disclaimer]
            + [
                f"{c.label} {c.value} {c.direction}"
                for c in explanation.all_contributions
            ]
        ).lower()
        for word in CAUSAL_WORDS:
            assert word not in text, f"explanation text used the causal word {word!r}"


def test_explanation_disclaims_causality(small_prepared, trained_xgboost, encoded_test):
    explanation = _explain(small_prepared, trained_xgboost, encoded_test, 0)
    assert "not causation" in explanation.disclaimer.lower()
    assert "contribution" in explanation.disclaimer.lower()


def test_summary_states_the_probability_in_plain_language(
    small_prepared, trained_xgboost, encoded_test
):
    explanation = _explain(small_prepared, trained_xgboost, encoded_test, 0)
    percent = explanation.churn_probability * 100
    assert f"{percent:.1f}%" in explanation.summary
    assert "model estimated" in explanation.summary


def test_sentence_templates_are_non_causal():
    assert "increased" in RISK_INCREASE_SENTENCE
    assert "reduced" in RISK_REDUCE_SENTENCE
    for sentence in (RISK_INCREASE_SENTENCE, RISK_REDUCE_SENTENCE):
        for word in CAUSAL_WORDS:
            assert word not in sentence.lower()


# -- global explanations -------------------------------------------------


def test_global_explanation_ranks_features_by_mean_absolute_shap(
    small_prepared, trained_xgboost, encoded_test
):
    features = small_prepared.result.encoded_features
    sample = encoded_test[:60]
    explanation = global_explanation(
        model_type=trained_xgboost.model_type,
        pipeline=trained_xgboost.pipeline,
        encoded_matrix=sample,
        features=features,
        feature_names=[f.name for f in features],
        model_id="m",
        model_version="v",
        background=sample[:30],
    )

    assert explanation.sample_size == 60
    assert len(explanation.features) == len(features)
    values = [f.mean_abs_shap for f in explanation.features]
    assert values == sorted(values, reverse=True)
    assert [f.rank for f in explanation.features] == list(range(1, len(features) + 1))
    assert all(f.mean_abs_shap >= 0 for f in explanation.features)


def test_global_explanation_notes_the_resampled_training_data(
    small_prepared, trained_xgboost, encoded_test
):
    features = small_prepared.result.encoded_features
    sample = encoded_test[:40]
    explanation = global_explanation(
        model_type=trained_xgboost.model_type,
        pipeline=trained_xgboost.pipeline,
        encoded_matrix=sample,
        features=features,
        feature_names=[f.name for f in features],
        model_id="m",
        model_version="v",
        background=sample[:20],
    )
    assert "SMOTE" in explanation.class_balance_note
    assert "not causation" in explanation.disclaimer.lower()


def test_global_explanation_on_a_single_row_still_works(
    small_prepared, trained_xgboost, encoded_test
):
    features = small_prepared.result.encoded_features
    explanation = global_explanation(
        model_type=trained_xgboost.model_type,
        pipeline=trained_xgboost.pipeline,
        encoded_matrix=encoded_test[:1],
        features=features,
        feature_names=[f.name for f in features],
        model_id="m",
        model_version="v",
        background=encoded_test[:1],
    )
    assert len(explanation.features) == len(features)


# -- logistic regression path -------------------------------------------


def test_logistic_regression_is_also_explainable(small_prepared):
    """Linear SHAP attributes in log-odds, and says so.

    The contributions must still reconstruct the prediction once the log-odds
    are mapped back through the logistic function, and the explanation must
    not present log-odds amounts as probability changes.
    """
    trained = train_single_model(
        small_prepared,
        "logistic_regression",
        preprocessing_id=small_prepared.result.preprocessing_id,
        cv_folds=3,
        random_seed=42,
    )
    transformer = trained.transformer
    encoded = np.asarray(transformer.transform(small_prepared.x_test), dtype=np.float64)
    explanation = _explain(small_prepared, trained, encoded, 2)

    assert explanation.churn_probability > 0
    rebuilt_log_odds = explanation.base_value + sum(
        c.shap_value for c in explanation.all_contributions
    )
    expected = 1 / (1 + np.exp(-rebuilt_log_odds))
    assert expected == pytest.approx(explanation.churn_probability, abs=1e-4)
    assert "log-odds" in explanation.summary
    assert "do not fully reconstruct" not in explanation.summary


def test_global_units_note_matches_the_explainer(small_prepared):
    features = small_prepared.result.encoded_features
    names = [f.name for f in features]

    trained = train_single_model(
        small_prepared,
        "logistic_regression",
        preprocessing_id=small_prepared.result.preprocessing_id,
        cv_folds=3,
        random_seed=42,
    )
    encoded = np.asarray(
        trained.transformer.transform(small_prepared.x_test), dtype=np.float64
    )[:40]
    linear = global_explanation(
        model_type="logistic_regression",
        pipeline=trained.pipeline,
        encoded_matrix=encoded,
        features=features,
        feature_names=names,
        model_id="m",
        model_version="v",
        background=encoded[:20],
    )
    assert "log-odds" in linear.class_balance_note


# -- value rendering -----------------------------------------------------


def test_describe_value_renders_readable_text():
    from app.schemas import EncodedFeature

    numeric = EncodedFeature(
        name="tenure", source_column="tenure", kind="numeric", scaled=True,
        label="Tenure (months)",
    )
    assert describe_value(numeric, "tenure", -1.28) == "Tenure (months) = -1.28"

    onehot = EncodedFeature(
        name="Contract_Two year", source_column="Contract", kind="onehot",
        level="Two year", label="Contract: Two year",
    )
    assert describe_value(onehot, "Contract_Two year", 1.0) == "Contract = Two year"
    assert "not 'Two year'" in describe_value(onehot, "Contract_Two year", 0.0)

    assert "f0" in describe_value(None, "f0", 0.5)


def test_an_unknown_feature_still_renders_something():
    assert describe_value(None, "mystery", 0.25) == "mystery = 0.25"
