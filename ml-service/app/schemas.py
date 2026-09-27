"""Request and response contracts for the machine learning service.

These schemas are the boundary between the Next.js application and Python.
Anything the application needs to persist or display has an explicit model here
so responses are validated rather than ad-hoc dictionaries.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

Severity = Literal["error", "warning", "info"]
RiskCategory = Literal["low", "medium", "high"]


class ColumnSummary(BaseModel):
    """One column of an uploaded dataset, as observed."""

    name: str
    position: int
    inferred_type: Literal["numeric", "boolean", "categorical", "text", "empty"]
    pandas_dtype: str
    non_null_count: int
    null_count: int
    null_fraction: float
    distinct_count: int
    sample_values: list[Any] = Field(default_factory=list)
    min_value: float | None = None
    max_value: float | None = None
    mean_value: float | None = None
    is_target: bool = False


class ValidationIssue(BaseModel):
    """A single validation finding."""

    code: str
    severity: Severity
    column: str | None = None
    message: str
    detail: str | None = None
    #: Machine-readable count of affected rows or columns, when applicable.
    affected_count: int | None = None


class InspectionReport(BaseModel):
    """Structural report produced before any modelling is attempted."""

    filename: str
    size_bytes: int
    row_count: int
    column_count: int
    columns: list[ColumnSummary]
    duplicate_row_count: int
    target_column: str
    target_distribution: dict[str, int]
    target_positive_rate: float
    total_charges_blank_rows: int
    total_charges_blank_with_zero_tenure: int
    blank_string_cells: int
    issues: list[ValidationIssue] = Field(default_factory=list)
    preview_rows: list[dict[str, Any]] = Field(default_factory=list)
    parser_used: str = "pandas.read_csv"


class PreprocessParams(BaseModel):
    """Configurable knobs for the documented preprocessing workflow."""

    target_column: str = "Churn"
    id_columns: list[str] = Field(default_factory=list)
    test_size: float = Field(default=0.2, gt=0.0, lt=0.9)
    stratify: bool = True
    apply_smote: bool = True
    smote_random_state: int = 42
    random_seed: int = 42
    #: When true TotalCharges blanks for customers with zero tenure become 0.0,
    #: matching the documented methodology. When false the run is rejected
    #: because a numeric column with holes cannot be standardised.
    impute_total_charges_from_zero_tenure: bool = True

    @field_validator("id_columns")
    @classmethod
    def _limit_id_columns(cls, value: list[str]) -> list[str]:
        if len(value) > 5:
            raise ValueError("At most 5 identifier columns may be supplied")
        return value


class PreprocessStepResult(BaseModel):
    """Outcome of one documented preprocessing step, for display in the UI."""

    step: str
    description: str
    affected_columns: list[str] = Field(default_factory=list)
    rows_in: int
    rows_out: int
    details: dict[str, Any] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)


class SplitSummary(BaseModel):
    train_rows: int
    test_rows: int
    train_churners: int
    test_churners: int
    train_churn_rate: float
    test_churn_rate: float
    stratified: bool
    random_seed: int


class ResampleSummary(BaseModel):
    applied: bool
    method: str | None = None
    scope: str
    rows_before: int | None = None
    rows_after: int | None = None
    minority_before: int | None = None
    minority_after: int | None = None
    note: str


class EncodedFeature(BaseModel):
    """Maps an encoded model input column back to its source column."""

    name: str
    source_column: str
    kind: Literal["numeric", "binary", "onehot", "boolean", "text"]
    level: str | None = None
    scaled: bool = False
    label: str


class PreprocessResult(BaseModel):
    """Everything needed to reproduce and audit a preprocessing run."""

    preprocessing_id: str
    created_at: datetime
    params: PreprocessParams
    source_row_count: int
    source_column_count: int
    target_column: str
    target_positive_rate: float
    steps: list[PreprocessStepResult]
    split: SplitSummary
    resample: ResampleSummary
    encoded_features: list[EncodedFeature]
    encoded_feature_count: int
    warnings: list[str] = Field(default_factory=list)
    scaler_mean: dict[str, float] = Field(default_factory=dict)
    scaler_scale: dict[str, float] = Field(default_factory=dict)


class GridSearchSummary(BaseModel):
    scoring_metric: str
    cv_folds: int
    cv_strategy: str
    candidates_evaluated: int
    best_params: dict[str, Any]
    best_cv_score: float
    mean_fit_time_seconds: float
    per_fold_scores: list[float] = Field(default_factory=list)


class ClassMetrics(BaseModel):
    accuracy: float
    precision: float
    recall: float
    f1: float
    roc_auc: float


class ConfusionMatrix(BaseModel):
    true_negative: int
    false_positive: int
    false_negative: int
    true_positive: int

    @property
    def total(self) -> int:
        return (
            self.true_negative
            + self.false_positive
            + self.false_negative
            + self.true_positive
        )


class DecileRow(BaseModel):
    decile: int
    customers: int
    churners: int
    churn_rate: float
    lift: float
    cumulative_captured: float


class DecileLift(BaseModel):
    deciles: int
    baseline_churn_rate: float
    rows: list[DecileRow]


class RocPoint(BaseModel):
    fpr: float
    tpr: float
    threshold: float


class RocCurve(BaseModel):
    points: list[RocPoint]
    auc: float


class ModelEvaluation(BaseModel):
    """Measured performance of one trained model, on one data split.

    The measured values are optional because a training run that failed has a
    recorded evaluation with no numbers in it. That is the honest shape for a
    failed run: the run exists, with its error, and no invented metrics.
    """

    split: Literal["validation_cv", "test"]
    sample_size: int
    positive_count: int
    metrics: ClassMetrics | None = None
    confusion_matrix: ConfusionMatrix | None = None
    roc: RocCurve | None = None
    threshold: float = 0.5
    evaluated_at: datetime
    notes: list[str] = Field(default_factory=list)


class TrainingModelResult(BaseModel):
    """One model family trained within a single run."""

    model_type: Literal["logistic_regression", "random_forest", "xgboost"]
    display_name: str
    status: Literal["completed", "failed"]
    grid_search: GridSearchSummary
    validation: ModelEvaluation
    test: ModelEvaluation | None = None
    decile_lift: DecileLift | None = None
    artifact_path: str | None = None
    error: str | None = None
    error_stage: str | None = None


class TrainingRunRequest(BaseModel):
    preprocessing_id: str
    model_types: list[str] = Field(
        default_factory=lambda: [
            "logistic_regression",
            "random_forest",
            "xgboost",
        ]
    )
    cv_folds: int = Field(default=5, ge=2, le=10)
    random_seed: int = 42
    run_label: str | None = None

    @field_validator("model_types")
    @classmethod
    def _validate_model_types(cls, value: list[str]) -> list[str]:
        from .config import SUPPORTED_MODEL_TYPES

        if not value:
            raise ValueError("At least one model type must be requested")
        unknown = [m for m in value if m not in SUPPORTED_MODEL_TYPES]
        if unknown:
            raise ValueError(
                f"Unsupported model types: {', '.join(sorted(unknown))}. "
                f"Supported: {', '.join(SUPPORTED_MODEL_TYPES)}"
            )
        return value


class TrainingRunStatus(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    run_id: str
    status: Literal[
        "queued", "running", "evaluating", "completed", "failed", "cancelled"
    ]
    stage: str
    progress_percent: int
    preprocessing_id: str
    label: str | None = None
    requested_models: list[str]
    started_at: datetime | None = None
    finished_at: datetime | None = None
    duration_seconds: float | None = None
    models: list[TrainingModelResult] = Field(default_factory=list)
    error: str | None = None
    error_stage: str | None = None
    diagnostics: dict[str, Any] = Field(default_factory=dict)


class ActivateModelRequest(BaseModel):
    """Activation is an application-level decision; the ML service only trains."""

    reason: str = Field(min_length=3, max_length=1000)


class RiskThresholds(BaseModel):
    """Configurable risk bands. Stored with every prediction."""

    high: float = Field(default=0.7, gt=0.0, lt=1.0)
    medium: float = Field(default=0.4, gt=0.0, lt=1.0)

    @field_validator("medium")
    @classmethod
    def _check_ordering(cls, value: float, info) -> float:
        high = info.data.get("high")
        if high is not None and value >= high:
            raise ValueError("medium threshold must be lower than high")
        return value


class PredictRequest(BaseModel):
    model_id: str
    thresholds: RiskThresholds = Field(default_factory=RiskThresholds)
    #: When provided the prediction is also written to a CSV alongside the
    #: dataset rows, keyed by these identifier columns.
    id_columns: list[str] = Field(default_factory=list)


class CustomerPrediction(BaseModel):
    row_index: int
    customer_id: str | None = None
    churn_probability: float
    predicted_label: int
    risk_category: RiskCategory
    risk_thresholds: RiskThresholds
    model_id: str
    model_version: str
    model_type: str


class PredictResponse(BaseModel):
    model_id: str
    model_version: str
    model_type: str
    row_count: int
    positive_rate: float
    risk_counts: dict[str, int]
    thresholds: RiskThresholds
    predictions: list[CustomerPrediction]
    warnings: list[str] = Field(default_factory=list)


class ShapContribution(BaseModel):
    feature: str
    label: str
    source_column: str
    value: Any
    shap_value: float
    direction: Literal["increases_risk", "reduces_risk"]
    kind: Literal["numeric", "binary", "onehot", "boolean", "text"]


class LocalExplanation(BaseModel):
    """A per-customer SHAP explanation written for a non-specialist."""

    model_id: str
    model_version: str
    model_type: str
    row_index: int
    customer_id: str | None = None
    churn_probability: float
    base_value: float
    #: Plain-language summary of the decision, never causal language.
    summary: str
    top_increasing_risk: list[ShapContribution]
    top_reducing_risk: list[ShapContribution]
    all_contributions: list[ShapContribution]
    #: The result of the additivity check, as data rather than as prose.
    #:
    #: A SHAP value the model does not agree with is not an explanation, so
    #: whether the contributions rebuild this prediction is reported explicitly.
    #: A client should not have to re-derive it, and should not have to parse
    #: the summary to find out.
    additive: bool
    #: The probability the base value and the contributions rebuild.
    reconstructed_probability: float
    #: The size of the difference that was allowed.
    additivity_tolerance: float
    waterfall_plot_path: str | None = None
    generated_at: datetime
    disclaimer: str = (
        "SHAP values describe how the model reached this prediction. They show "
        "association and contribution, not causation."
    )


class GlobalFeatureImportance(BaseModel):
    rank: int
    feature: str
    label: str
    source_column: str
    mean_abs_shap: float
    direction: Literal["increases_risk", "reduces_risk", "mixed"]
    kind: Literal["numeric", "binary", "onehot", "boolean", "text"]


class GlobalExplanation(BaseModel):
    model_id: str
    model_version: str
    model_type: str
    sample_size: int
    class_balance_note: str
    features: list[GlobalFeatureImportance]
    beeswarm_plot_path: str | None = None
    importance_plot_path: str | None = None
    generated_at: datetime
    disclaimer: str = (
        "SHAP values describe how the model reached its predictions. They show "
        "association and contribution, not causation."
    )


class ShapCapability(BaseModel):
    """Declares which explainer the model supports, so the UI can be honest."""

    model_type: str
    explainer: str
    exact: bool
    reason: str


class ServiceHealth(BaseModel):
    status: Literal["ok", "degraded"]
    version: str
    artifact_dir: str
    authentication_required: bool
    library_versions: dict[str, str]
