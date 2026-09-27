"""Prediction and SHAP explanation endpoints.

A prediction is always traceable to the exact model version and preprocessing
run that produced it, and an explanation is always traceable to the prediction.
Those references travel with every response.
"""

from __future__ import annotations

import functools
from typing import Any

import anyio
import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status

from ..pipeline.explainability import (
    ExplanationError,
    background_sample,
    describe_capability,
    global_explanation,
    local_explanation,
    plot_path,
)
from ..pipeline.inspection import DatasetError, read_dataset
from ..pipeline.plots import plot_shap_beeswarm, plot_shap_importance, plot_shap_waterfall
from ..schemas import (
    CustomerPrediction,
    GlobalExplanation,
    LocalExplanation,
    PredictResponse,
    PreprocessParams,
    RiskThresholds,
    ShapCapability,
)
from ..pipeline.preprocessing import clean_frame
from ..store import ArtifactError, model_store
from .auth import require_api_key
from .datasets import _read_upload

router = APIRouter(
    tags=["predictions"], dependencies=[Depends(require_api_key)]
)

RISK_BANDS = ("low", "medium", "high")

# The boundary that turns a probability into a predicted class.
#
# Deliberately fixed at 0.5 and independent of the risk bands. The bands are an
# operational triage aid a person can move; the class prediction is the model's
# decision and has to match the threshold the reported metrics were computed at,
# or the counts on screen would disagree with the confusion matrix above them.
DECISION_THRESHOLD = 0.5


def _categorise(probability: float, thresholds: RiskThresholds) -> str:
    if probability >= thresholds.high:
        return "high"
    if probability >= thresholds.medium:
        return "medium"
    return "low"


def _model_or_404(model_id: str):
    try:
        return model_store.load_model(model_id)
    except ArtifactError as exc:
        # ArtifactError is a plain RuntimeError carrying its message as the
        # exception text, not in a `message` attribute. Reading a `message`
        # attribute here would raise inside the error handler and turn a 404
        # into a 500.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)
        ) from exc


def _preprocessing_or_400(preprocessing_id: str):
    try:
        return model_store.load_preprocessing(preprocessing_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"The preprocessing run '{preprocessing_id}' behind this model "
                f"is unavailable: {exc}"
            ),
        ) from exc


@router.get(
    "/models/{model_id}/explanation-capability",
    response_model=ShapCapability,
    summary="Describe which explainer backs this model",
)
async def capability(model_id: str) -> ShapCapability:
    loaded = _model_or_404(model_id)
    return describe_capability(loaded.model_type)


@router.post(
    "/models/{model_id}/predict",
    response_model=PredictResponse,
    summary="Score customers from an uploaded dataset",
)
async def predict(
    model_id: str,
    file: UploadFile = File(...),
    high_threshold: float = Form(default=0.7, gt=0.0, lt=1.0),
    medium_threshold: float = Form(default=0.4, gt=0.0, lt=1.0),
    id_columns: str | None = Form(default=None),
) -> PredictResponse:
    """Score every row of a dataset with a trained model."""
    loaded = _model_or_404(model_id)
    preprocessor, metadata = _preprocessing_or_400(loaded.preprocessing_id)
    thresholds = _thresholds(high_threshold, medium_threshold)

    raw = await _read_upload(file)
    try:
        frame = read_dataset(raw, file.filename or "dataset.csv")
    except DatasetError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": exc.code, "message": exc.message},
        ) from exc

    target_column = metadata["params"]["target_column"]
    ids = [c.strip() for c in (id_columns or "").split(",") if c.strip()]
    if not ids:
        recorded = metadata["params"].get("id_columns") or []
        ids = [c for c in recorded if c in frame.columns]

    # Clean before encoding, the same way the training rows were cleaned.
    frame, clean_warnings = _clean_for_preprocessing(frame, metadata)

    warnings: list[str] = list(clean_warnings)
    if target_column in frame.columns and target_column not in ids:
        frame = frame.drop(columns=[target_column])
    elif target_column in frame.columns:
        warnings.append(
            "The target column was also listed as an identifier and was "
            "excluded from the model's inputs."
        )
        frame = frame.drop(columns=[target_column])

    for column in ids:
        if column not in frame.columns:
            warnings.append(
                f"Identifier column '{column}' is not in this file, so "
                "predictions will be keyed by row number."
            )

    if frame.empty:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The dataset has no rows to score.",
        )

    # The fitted transformer is used to validate the file and to report what
    # would happen, but the model's own pipeline carries the transformer that was
    # fitted alongside it, and that is the one that must score the rows. Passing
    # the already-encoded matrix here would hand the pipeline a 40-column frame
    # where it expects the 20 raw columns.
    try:
        encoded = np.asarray(preprocessor.transform(frame), dtype=np.float64)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                "This dataset does not match the columns the model was trained "
                f"on: {exc}"
            ),
        ) from exc

    if not np.isfinite(encoded).all():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                "The dataset produced values that are not finite after "
                "preprocessing. Check the numeric columns for blanks or text."
            ),
        )

    probabilities = loaded.pipeline.predict_proba(frame)[:, 1]

    predictions: list[CustomerPrediction] = []
    for index in range(len(frame)):
        probability = float(probabilities[index])
        customer_id = None
        if ids and ids[0] in frame.columns:
            customer_id = str(frame.iloc[index][ids[0]])
        predictions.append(
            CustomerPrediction(
                row_index=index,
                customer_id=customer_id,
                churn_probability=round(probability, 6),
                predicted_label=int(probability >= DECISION_THRESHOLD),
                risk_category=_categorise(probability, thresholds),  # type: ignore[arg-type]
                risk_thresholds=thresholds,
                model_id=model_id,
                model_version=loaded.version,
                model_type=loaded.model_type,
            )
        )

    risk_counts = {band: 0 for band in RISK_BANDS}
    for prediction in predictions:
        risk_counts[prediction.risk_category] += 1

    return PredictResponse(
        model_id=model_id,
        model_version=loaded.version,
        model_type=loaded.model_type,
        row_count=len(predictions),
        positive_rate=round(float(probabilities.mean()), 6),
        risk_counts=risk_counts,
        thresholds=thresholds,
        predictions=predictions,
        warnings=warnings,
    )


@router.post(
    "/models/{model_id}/explanations/global",
    response_model=GlobalExplanation,
    summary="Global SHAP feature importance",
)
async def global_shap(
    model_id: str,
    file: UploadFile = File(...),
    sample_size: int = Form(default=1000, ge=10, le=5000),
    render_plots: bool = Form(default=True),
) -> GlobalExplanation:
    """Rank features by mean absolute SHAP value over a sample of customers."""
    loaded = _model_or_404(model_id)
    preprocessor, metadata = _preprocessing_or_400(loaded.preprocessing_id)
    features = model_store.encoded_features(loaded.preprocessing_id)
    feature_names = [f.name for f in features]

    raw = await _read_upload(file)
    try:
        frame = read_dataset(raw, file.filename or "dataset.csv")
    except DatasetError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": exc.code, "message": exc.message},
        ) from exc

    target_column = metadata["params"]["target_column"]
    if target_column in frame.columns:
        frame = frame.drop(columns=[target_column])
    for column in metadata["params"].get("id_columns", []) or []:
        if column in frame.columns:
            frame = frame.drop(columns=[column])

    # Clean before encoding, so the sample matches what the model was trained on.
    frame, _warnings = _clean_for_preprocessing(frame, metadata)

    try:
        encoded = np.asarray(preprocessor.transform(frame), dtype=np.float64)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"This dataset does not match the model's training columns: {exc}",
        ) from exc

    n = min(sample_size, encoded.shape[0])
    rng = np.random.default_rng(loaded.random_seed or 42)
    indices = np.sort(rng.choice(encoded.shape[0], size=n, replace=False))
    sample = encoded[indices]

    try:
        background = background_sample(sample, size=min(100, sample.shape[0]))
        # SHAP over the sample is the slow part, so it runs off the event loop.
        explanation = await _offload(
            global_explanation,
            model_type=loaded.model_type,
            pipeline=loaded.pipeline,
            encoded_matrix=sample,
            features=features,
            feature_names=feature_names,
            model_id=model_id,
            model_version=loaded.version,
            background=background,
        )
    except ExplanationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "explanation_failed", "message": exc.message},
        ) from exc

    if render_plots:
        explanation = await _offload(
            _with_global_plots,
            explanation,
            loaded,
            sample,
            background,
            feature_names,
        )

    return explanation


def _with_global_plots(
    explanation: GlobalExplanation,
    loaded,
    sample: np.ndarray,
    background: np.ndarray,
    feature_names: list[str],
) -> GlobalExplanation:
    """Render the beeswarm and ranked-importance charts, best effort.

    A plotting failure downgrades the response to data-only rather than failing
    the request, because the ranked table is the part an operator needs.
    """
    import shap

    from ..pipeline.explainability import _build_explainer, _raw_values

    try:
        explainer, _method, _probability = _build_explainer(
            loaded.estimator, background, loaded.model_type
        )
        raw = explainer.shap_values(sample)
        shap_matrix = _raw_values(explainer, raw, sample.shape[0])
        explanation.beeswarm_plot_path = plot_shap_beeswarm(
            shap_matrix,
            sample,
            feature_names,
            plot_path(f"{loaded.model_id}-beeswarm"),
            f"{loaded.model_type.replace('_', ' ').title()} - SHAP summary",
        )
        explanation.importance_plot_path = plot_shap_importance(
            [f.model_dump() for f in explanation.features],
            plot_path(f"{loaded.model_id}-importance"),
            f"{loaded.model_type.replace('_', ' ').title()} - mean absolute SHAP value",
        )
    except Exception:  # noqa: BLE001
        pass
    del shap
    return explanation


@router.post(
    "/models/{model_id}/explanations/local",
    response_model=LocalExplanation,
    summary="Per-customer SHAP explanation",
)
async def local_shap(
    model_id: str,
    file: UploadFile = File(...),
    row_index: int = Form(default=0, ge=0),
    customer_id: str | None = Form(default=None),
    top_n: int = Form(default=5, ge=1, le=20),
    render_plot: bool = Form(default=True),
) -> LocalExplanation:
    """Explain one customer's prediction in plain language."""
    loaded = _model_or_404(model_id)
    preprocessor, metadata = _preprocessing_or_400(loaded.preprocessing_id)
    features = model_store.encoded_features(loaded.preprocessing_id)
    feature_names = [f.name for f in features]

    raw = await _read_upload(file)
    try:
        frame = read_dataset(raw, file.filename or "dataset.csv")
    except DatasetError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": exc.code, "message": exc.message},
        ) from exc

    if row_index >= len(frame):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(
                f"Row {row_index} is outside this dataset, which has "
                f"{len(frame)} rows."
            ),
        )

    target_column = metadata["params"]["target_column"]
    work = frame.drop(columns=[target_column]) if target_column in frame.columns else frame
    for column in metadata["params"].get("id_columns", []) or []:
        if column in work.columns:
            work = work.drop(columns=[column])

    # Clean before encoding. Without this a customer with a blank TotalCharges
    # value would be encoded as NaN and the explanation would be meaningless.
    work, _warnings = _clean_for_preprocessing(work, metadata)

    try:
        encoded_all = np.asarray(preprocessor.transform(work), dtype=np.float64)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"This dataset does not match the model's training columns: {exc}",
        ) from exc

    row = encoded_all[row_index].reshape(1, -1)
    try:
        background = background_sample(
            encoded_all, size=min(100, encoded_all.shape[0]), seed=loaded.random_seed or 42
        )
        # Building the explainer is the slow part, so it runs off the event loop.
        explanation = await _offload(
            local_explanation,
            model_type=loaded.model_type,
            pipeline=loaded.pipeline,
            encoded_row=row,
            features=features,
            feature_names=feature_names,
            background=background,
            model_id=model_id,
            model_version=loaded.version,
            customer_id=customer_id,
            row_index=row_index,
            top_n=top_n,
        )
    except ExplanationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "explanation_failed", "message": exc.message},
        ) from exc

    if render_plot:
        try:
            explanation.waterfall_plot_path = await _offload(
                plot_shap_waterfall,
                [c.model_dump() for c in explanation.all_contributions],
                plot_path(f"{loaded.model_id}-local-{row_index}"),
                f"SHAP contributions for row {row_index}",
            )
        except Exception:  # noqa: BLE001
            pass

    return explanation


def _clean_for_preprocessing(
    frame: pd.DataFrame, metadata: dict
) -> tuple[pd.DataFrame, list[str]]:
    """Apply the cleaning the fitted transformer does not include.

    The stored `ColumnTransformer` encodes columns but does not coerce
    `TotalCharges` to a number or resolve its blanks, because those change the
    frame rather than the encoding. A freshly uploaded file therefore has to go
    through the same cleaning the training rows did, or a legitimate dataset —
    including the one the model was trained on — is rejected as non-finite.
    """
    params = PreprocessParams.model_validate(metadata["params"])
    return clean_frame(frame, params)


async def _offload(function: Any, /, *args: Any, **kwargs: Any) -> Any:
    """Run a CPU-bound call in a worker thread.

    The handlers are `async def` so they can await the upload, but SHAP and
    Matplotlib take seconds to minutes. Running them on the event loop would
    stall every other request in the process, including the status polls the UI
    makes while waiting, so the work is handed to a thread.
    """
    return await anyio.to_thread.run_sync(
        functools.partial(function, *args, **kwargs)
    )


def _thresholds(high: float, medium: float) -> RiskThresholds:
    try:
        return RiskThresholds(high=high, medium=medium)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid risk thresholds: {exc}",
        ) from exc
