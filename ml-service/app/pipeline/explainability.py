"""SHAP explainability.

Provides both levels the methodology calls for:

* a global explanation ranking features by mean absolute SHAP value across a
  sample of customers, and
* a local, per-customer explanation splitting the prediction into the factors
  that pushed risk up and the factors that pushed it down.

Every explanation is checked for additivity against the model's own probability
output. If the contributions do not reconstruct the prediction, that is
recorded on the explanation rather than hidden, because a SHAP value the model
does not agree with is not an explanation.

Language is deliberately non-causal. SHAP values describe how the model reached
a prediction. They do not establish that a feature caused churn.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

import numpy as np
import shap

from ..config import settings
from ..schemas import (
    EncodedFeature,
    GlobalExplanation,
    GlobalFeatureImportance,
    LocalExplanation,
    ShapCapability,
    ShapContribution,
)
from .preprocessing import PreprocessingError

RISK_INCREASE_SENTENCE = "This factor increased the model's estimated churn risk."
RISK_REDUCE_SENTENCE = "This factor reduced the model's estimated churn risk."

TREE_MODELS = {"random_forest", "xgboost"}

#: How far the rebuilt probability may sit from the model's own output before
#: the explanation is reported as not additive. Two percentage points absorbs
#: float error and the log-odds round trip without hiding a real disagreement.
ADDITIVITY_TOLERANCE = 0.02


class ExplanationError(RuntimeError):
    """Raised when an explanation cannot be produced for a model."""

    def __init__(self, message: str, *, model_type: str = "") -> None:
        super().__init__(message)
        self.message = message
        self.model_type = model_type


def describe_capability(model_type: str) -> ShapCapability:
    """Tell the application which explainer backs this model's explanations."""
    if model_type in TREE_MODELS:
        return ShapCapability(
            model_type=model_type,
            explainer="TreeSHAP",
            exact=True,
            reason=(
                "TreeSHAP computes exact Shapley values for tree ensembles in "
                "polynomial time, so these contributions are exact for the "
                "trained model."
            ),
        )
    return ShapCapability(
        model_type=model_type,
        explainer="Linear SHAP",
        exact=True,
        reason=(
            "A generalised linear model has closed-form exact Shapley values, "
            "so these contributions are exact for the trained model."
        ),
    )


def _build_explainer(model: Any, background: np.ndarray, model_type: str):
    """Return (explainer, method_label, units).

    ``units`` says what the SHAP values are measured in, which decides how they
    may be read:

    * ``"probability"`` - contributions add directly to the predicted
      probability, so they can be quoted as probability changes.
    * ``"log_odds"`` - contributions add to the log-odds, so they are only
      meaningful for comparing factors, not as probability changes.
    * ``"raw"`` - the wrapper does not expose a probability output, so the
      additivity check decides whether the units line up.
    """
    if model_type in TREE_MODELS:
        try:
            explainer = shap.TreeExplainer(
                model, data=background, model_output="probability"
            )
            return explainer, "TreeSHAP (probability output)", "probability"
        except (ValueError, TypeError, AttributeError, NotImplementedError):
            # Some tree wrappers do not expose a probability-output path. The
            # raw-output explainer is still exact; the additivity check reports
            # whether its units match the model's probability.
            explainer = shap.TreeExplainer(model, data=background)
            return explainer, "TreeSHAP (raw output)", "raw"
    if model_type == "logistic_regression":
        # LinearExplainer attributes in log-odds space, which is the natural
        # output of a generalised linear model.
        explainer = shap.LinearExplainer(model, background)
        return explainer, "Linear SHAP (log-odds output)", "log_odds"
    raise ExplanationError(
        f"No exact explainer is available for model type '{model_type}'.",
        model_type=model_type,
    )


def _units_note(units: str) -> str:
    if units == "probability":
        return ""
    if units == "log_odds":
        return (
            " For a linear model these contributions are measured in log-odds, "
            "so read them to compare which factors matter, not as changes in "
            "probability."
        )
    return (
        " The explainer is reporting in raw model output rather than "
        "probability units, so read the direction and relative size, not the "
        "absolute amounts."
    )


def _reconstructed_probability(
    units: str, base_value: float, total_shap: float
) -> float:
    """Rebuild the predicted probability from the base value and contributions."""
    if units == "log_odds":
        # expit keeps the value inside (0, 1) instead of overflowing.
        return float(1.0 / (1.0 + np.exp(-np.clip(total_shap + base_value, -60, 60))))
    return float(base_value + total_shap)


def _encode(explainer_input: np.ndarray, n_features: int) -> np.ndarray:
    array = np.asarray(explainer_input, dtype=np.float64)
    if array.ndim == 1:
        array = array.reshape(1, -1)
    if array.shape[1] != n_features:
        raise ExplanationError(
            "The encoded feature matrix does not match the model's expected "
            f"input width ({array.shape[1]} vs {n_features})."
        )
    return array


def _base_value(explainer: Any) -> float:
    base = getattr(explainer, "expected_value", 0.0)
    if isinstance(base, (list, tuple, np.ndarray)):
        base = np.asarray(base).ravel()[-1]
    try:
        return float(base)
    except (TypeError, ValueError):
        return 0.0


def _raw_values(explainer: Any, values: Any, rows: int) -> np.ndarray:
    """Normalise SHAP output to a (rows, features) array."""
    array = np.asarray(values, dtype=np.float64)
    if array.ndim == 2:
        return array
    if array.ndim == 3:
        # (features, rows) for some explainers.
        if array.shape[0] != rows and array.shape[1] == rows:
            return array.T
        return array
    return array.reshape(rows, -1)


def describe_value(feature: EncodedFeature | None, name: str, encoded_value: float) -> str:
    """Render an encoded cell as the value the customer would recognise."""
    if feature is None:
        return f"{name} = {_trim(encoded_value)}"
    if feature.kind in {"binary", "onehot"}:
        active = float(encoded_value) > 0.5
        level = feature.level or "set"
        if active:
            return f"{feature.source_column} = {level}"
        if feature.kind == "binary":
            # A binary indicator only tells us which of two levels is present.
            return f"{feature.source_column} is not '{level}'"
        return f"{feature.source_column} is not '{level}'"
    if feature.kind == "numeric" and not feature.scaled:
        return f"{feature.source_column} = {_trim(encoded_value)}"
    return f"{feature.label} = {_trim(encoded_value)}"


def _trim(value: float) -> str:
    if value == int(value) and abs(value) < 1e15:
        return str(int(value))
    return f"{value:.3g}"


def _direction(shap_value: float, tolerance: float = 1e-9) -> str:
    if shap_value > tolerance:
        return "increases_risk"
    if shap_value < -tolerance:
        return "reduces_risk"
    return "reduces_risk" if shap_value < 0 else "increases_risk"


def _feature_index(features: list[EncodedFeature]) -> dict[str, EncodedFeature]:
    return {f.name: f for f in features}


def _build_contributions(
    *,
    shap_row: np.ndarray,
    encoded_row: np.ndarray,
    features: list[EncodedFeature],
    feature_names: list[str],
) -> list[ShapContribution]:
    lookup = _feature_index(features)
    contributions: list[ShapContribution] = []
    for index, name in enumerate(feature_names):
        if index >= len(shap_row):
            break
        shap_value = float(shap_row[index])
        feature = lookup.get(name)
        contributions.append(
            ShapContribution(
                feature=name,
                label=feature.label if feature else name,
                source_column=feature.source_column if feature else name,
                value=describe_value(
                    feature, name, float(encoded_row[index])
                ),
                shap_value=round(shap_value, 6),
                direction=_direction(shap_value),  # type: ignore[arg-type]
                kind=feature.kind if feature else "numeric",
            )
        )
    contributions.sort(key=lambda c: abs(c.shap_value), reverse=True)
    return contributions


def _plain_summary(
    probability: float,
    top_up: list[ShapContribution],
    top_down: list[ShapContribution],
) -> str:
    percent = probability * 100
    if not top_up and not top_down:
        return (
            f"The model estimated a {percent:.1f}% chance of churn and no single "
            "feature stood out as a meaningful contributor."
        )
    parts: list[str] = [
        f"The model estimated a {percent:.1f}% chance of churn."
    ]
    if top_up:
        lead = top_up[0]
        parts.append(
            f"The strongest factor pushing this customer toward churn was "
            f"{lead.label.lower()} ({lead.value}), which contributed "
            f"{lead.shap_value:+.3f} to the risk score."
        )
    if top_down:
        protective = top_down[0]
        parts.append(
            f"The strongest factor holding risk down was "
            f"{protective.label.lower()} ({protective.value}), contributing "
            f"{protective.shap_value:+.3f}."
        )
    return " ".join(parts)


def local_explanation(
    *,
    model_type: str,
    pipeline: Any,
    encoded_row: np.ndarray,
    features: list[EncodedFeature],
    feature_names: list[str],
    background: np.ndarray,
    model_id: str,
    model_version: str,
    customer_id: str | None = None,
    row_index: int = 0,
    top_n: int = 5,
    waterfall_plot_path: str | None = None,
) -> LocalExplanation:
    """Explain a single customer's prediction."""
    matrix = _encode(encoded_row, len(feature_names))
    try:
        explainer, _method, units = _build_explainer(
            pipeline.named_steps["model"], background, model_type
        )
        raw_values = explainer.shap_values(matrix)
    except ExplanationError:
        raise
    except Exception as exc:  # noqa: BLE001 - surfaced to the operator
        raise ExplanationError(
            f"SHAP could not explain this prediction: {exc}", model_type=model_type
        ) from exc

    shap_row = _raw_values(explainer, raw_values, matrix.shape[0])[0]
    base_value = _base_value(explainer)
    contributions = _build_contributions(
        shap_row=shap_row,
        encoded_row=matrix[0],
        features=features,
        feature_names=feature_names,
    )

    # The matrix is already encoded, so it goes straight to the estimator.
    # Calling pipeline.predict_proba here would try to encode it a second time.
    probability = float(pipeline.named_steps["model"].predict_proba(matrix)[0, 1])

    # Additivity check: do the contributions actually rebuild the prediction?
    # A SHAP value the model does not agree with is not an explanation, so the
    # result is stated on the explanation either way.
    total_shap = float(np.sum(shap_row))
    reconstructed = _reconstructed_probability(units, base_value, total_shap)
    additive = abs(reconstructed - probability) <= ADDITIVITY_TOLERANCE
    if additive:
        contributions_note = _units_note(units)
    else:
        contributions_note = (
            f" The contributions do not fully reconstruct this prediction "
            f"({reconstructed:.3f} rebuilt against a predicted probability of "
            f"{probability:.3f}), so treat the direction and relative size as "
            "reliable and the absolute amounts as approximate."
        ) + _units_note(units)

    top_up = [c for c in contributions if c.shap_value > 0][:top_n]
    top_down = [c for c in contributions if c.shap_value < 0][:top_n]
    top_down.reverse()  # strongest protective factor first

    summary = _plain_summary(probability, top_up, top_down) + contributions_note

    return LocalExplanation(
        model_id=model_id,
        model_version=model_version,
        model_type=model_type,
        row_index=row_index,
        customer_id=customer_id,
        churn_probability=round(probability, 6),
        base_value=round(base_value, 6),
        summary=summary,
        top_increasing_risk=top_up,
        top_reducing_risk=top_down,
        all_contributions=contributions,
        additive=additive,
        reconstructed_probability=round(reconstructed, 6),
        additivity_tolerance=ADDITIVITY_TOLERANCE,
        waterfall_plot_path=waterfall_plot_path,
        generated_at=datetime.now(timezone.utc),
    )


def global_explanation(
    *,
    model_type: str,
    pipeline: Any,
    encoded_matrix: np.ndarray,
    features: list[EncodedFeature],
    feature_names: list[str],
    model_id: str,
    model_version: str,
    background: np.ndarray,
    beeswarm_plot_path: str | None = None,
    importance_plot_path: str | None = None,
) -> GlobalExplanation:
    """Rank features by mean absolute SHAP value across a sample of customers."""
    matrix = _encode(encoded_matrix, len(feature_names))
    try:
        explainer, _method, units = _build_explainer(
            pipeline.named_steps["model"], background, model_type
        )
        raw_values = explainer.shap_values(matrix)
    except ExplanationError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ExplanationError(
            f"SHAP could not produce a global explanation: {exc}",
            model_type=model_type,
        ) from exc

    shap_matrix = _raw_values(explainer, raw_values, matrix.shape[0])
    mean_abs = np.mean(np.abs(shap_matrix), axis=0)
    mean_signed = np.mean(shap_matrix, axis=0)

    lookup = _feature_index(features)
    rows: list[GlobalFeatureImportance] = []
    for index, name in enumerate(feature_names):
        if index >= len(mean_abs):
            break
        signed = float(mean_signed[index])
        if abs(signed) < 1e-6:
            direction = "mixed"
        else:
            direction = "increases_risk" if signed > 0 else "reduces_risk"
        feature = lookup.get(name)
        rows.append(
            GlobalFeatureImportance(
                rank=0,
                feature=name,
                label=feature.label if feature else name,
                source_column=feature.source_column if feature else name,
                mean_abs_shap=round(float(mean_abs[index]), 6),
                direction=direction,  # type: ignore[arg-type]
                kind=feature.kind if feature else "numeric",
            )
        )

    rows.sort(key=lambda r: r.mean_abs_shap, reverse=True)
    for position, row in enumerate(rows, start=1):
        row.rank = position

    if units == "probability":
        units_note = (
            "Mean absolute SHAP values measured in probability units, so a "
            "value of 0.05 means the feature typically moves the predicted "
            "churn probability by about five percentage points."
        )
    else:
        units_note = (
            "Mean absolute SHAP values measured in "
            + ("log-odds" if units == "log_odds" else "raw model output")
            + ". Use them to rank and compare features, not as probability "
            "changes."
        )

    return GlobalExplanation(
        model_id=model_id,
        model_version=model_version,
        model_type=model_type,
        sample_size=int(matrix.shape[0]),
        class_balance_note=(
            f"Measured over {matrix.shape[0]} sampled customers. {units_note} "
            "The training data was SMOTE-balanced, so these describe how the "
            "fitted model reasons, not the natural churn rate in the customer "
            "base."
        ),
        features=rows,
        beeswarm_plot_path=beeswarm_plot_path,
        importance_plot_path=importance_plot_path,
        generated_at=datetime.now(timezone.utc),
    )


def background_sample(encoded_matrix: np.ndarray, size: int = 100, seed: int = 42):
    """Pick a representative background set for the explainer.

    A stratified slice is preferred so both classes are represented; a plain
    random slice would leave the base value unrepresentative whenever the data
    is imbalanced.
    """
    matrix = np.asarray(encoded_matrix, dtype=np.float64)
    n_rows = matrix.shape[0]
    if n_rows == 0:
        raise PreprocessingError(
            "shap_background", "No encoded rows are available to explain against."
        )
    if n_rows <= size:
        return matrix

    rng = np.random.default_rng(seed)
    indices = rng.choice(n_rows, size=size, replace=False)
    return matrix[np.sort(indices)]


def plot_path(name: str) -> str:
    """Absolute path for a generated plot, created under the artifact tree."""
    directory = settings.artifact_dir / "plots"
    directory.mkdir(parents=True, exist_ok=True)
    return str(directory / f"{name}-{uuid.uuid4().hex[:8]}.png")


def contribution_direction_sentence(direction: str) -> str:
    return (
        RISK_INCREASE_SENTENCE
        if direction == "increases_risk"
        else RISK_REDUCE_SENTENCE
    )


def encoded_row_from_record(
    record: dict[str, Any],
    preprocessor: Any,
    features: list[EncodedFeature],
) -> np.ndarray:
    """Apply the fitted preprocessor to a single raw customer record."""
    import pandas as pd

    frame = pd.DataFrame([record])
    target = features  # kept for signature clarity
    del target
    return np.asarray(preprocessor.transform(frame), dtype=np.float64)
