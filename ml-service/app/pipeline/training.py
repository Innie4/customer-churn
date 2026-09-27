"""Model training.

Three model families are trained under identical conditions: an 80:20
stratified split, stratified k-fold cross-validation inside the training split
only, grid search scored on AUC-ROC, and a final evaluation on the untouched
test split.

Training is real. There is no simulation path in this module. A failure is
recorded on the run with the stage that failed and the error that occurred.
"""

from __future__ import annotations

import time
import traceback
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal

import joblib
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GridSearchCV, StratifiedKFold
from xgboost import XGBClassifier

from ..config import settings
from ..schemas import (
    GridSearchSummary,
    ModelEvaluation,
    TrainingModelResult,
)
from .evaluation import evaluate_split
from .preprocessing import (
    PreparedData,
    PreprocessingError,
    build_training_pipeline,
    resolve_spec,
)

ModelType = Literal["logistic_regression", "random_forest", "xgboost"]

DISPLAY_NAMES: dict[str, str] = {
    "logistic_regression": "Logistic Regression",
    "random_forest": "Random Forest",
    "xgboost": "XGBoost",
}


def make_estimator(model_type: str, random_seed: int) -> Any:
    """Instantiate one estimator with reproducibility settings applied."""
    if model_type == "logistic_regression":
        return LogisticRegression(max_iter=2000, random_state=random_seed)
    if model_type == "random_forest":
        return RandomForestClassifier(random_state=random_seed, n_jobs=-1)
    if model_type == "xgboost":
        return XGBClassifier(
            random_state=random_seed,
            eval_metric="logloss",
            tree_method="hist",
            n_jobs=2,
        )
    raise ValueError(f"Unsupported model type: {model_type}")


def param_grid(model_type: str) -> dict[str, list[Any]]:
    """The documented search space for each family.

    Grids are deliberately modest. Each model is already a strong performer on
    this dataset, and a wide grid multiplies fit time without changing the
    comparison the study is making.
    """
    if model_type == "logistic_regression":
        return {
            "model__C": [0.01, 0.1, 1.0, 10.0],
            "model__penalty": ["l2"],
            "model__solver": ["lbfgs"],
        }
    if model_type == "random_forest":
        return {
            "model__n_estimators": [200],
            "model__max_depth": [None, 12],
            "model__min_samples_leaf": [1, 2],
        }
    if model_type == "xgboost":
        return {
            "model__n_estimators": [300],
            "model__max_depth": [3, 5],
            "model__learning_rate": [0.1],
        }
    raise ValueError(f"Unsupported model type: {model_type}")


def _readable_params(best_params: dict[str, Any]) -> dict[str, Any]:
    """Strip the pipeline step prefix so the UI can show real hyperparameter names."""
    return {
        key.split("__", 1)[-1]: value for key, value in best_params.items()
    }


@dataclass
class TrainedModel:
    """A fitted model plus everything needed to reproduce and explain it."""

    model_type: str
    version: str
    pipeline: Any
    result: TrainingModelResult
    feature_names: list[str]
    preprocessing_id: str
    random_seed: int
    created_at: datetime
    hyperparameter_count: int = 0
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def model_id(self) -> str:
        """The identifier the application uses to reference this model."""
        return f"{self.model_type}-{self.version}"

    @property
    def estimator(self) -> Any:
        """The final estimator, which operates on the encoded feature matrix."""
        return self.pipeline.named_steps["model"]

    @property
    def transformer(self) -> Any:
        """The fitted encoder/scaler that the estimator expects upstream."""
        return self.pipeline.named_steps["preprocess"]


def train_single_model(
    prepared: PreparedData,
    model_type: str,
    *,
    preprocessing_id: str,
    cv_folds: int,
    random_seed: int,
) -> TrainedModel:
    """Tune and fit one model family, then evaluate it on the test split."""
    started = time.perf_counter()
    estimator = make_estimator(model_type, random_seed)

    apply_smote = prepared.result.resample.applied
    spec = resolve_spec(prepared.x_train)
    pipeline = build_training_pipeline(
        spec=spec,
        estimator=estimator,
        apply_smote=apply_smote,
        smote_random_state=random_seed,
    )

    grid = param_grid(model_type)
    candidates = int(np.prod([len(v) for v in grid.values()]))

    # Cross-validation runs on the training split only. The test split never
    # participates in tuning.
    usable_folds = min(cv_folds, int(np.bincount(prepared.y_train).min()))
    if usable_folds < 2:
        raise ValueError(
            "The training split does not have enough minority-class rows for "
            f"{cv_folds}-fold cross-validation. Reduce the fold count or "
            "supply a larger dataset."
        )

    search = GridSearchCV(
        estimator=pipeline,
        param_grid=grid,
        scoring="roc_auc",
        cv=StratifiedKFold(n_splits=usable_folds, shuffle=True, random_state=random_seed),
        n_jobs=1,
        refit=True,
        return_train_score=False,
        error_score="raise",
    )

    search.fit(prepared.x_train, prepared.y_train)

    best_index = int(search.best_index_)
    cv_results = search.cv_results_
    # cv_results holds one row per candidate; column split<i>_test_score holds
    # that candidate's score on fold <i>.
    per_fold = [
        float(cv_results[f"split{i}_test_score"][best_index])
        for i in range(usable_folds)
    ]

    grid_summary = GridSearchSummary(
        scoring_metric="roc_auc",
        cv_folds=usable_folds,
        cv_strategy=f"StratifiedKFold(n_splits={usable_folds}, shuffle=True, "
        f"random_state={random_seed})",
        candidates_evaluated=candidates,
        best_params=_readable_params(search.best_params_),
        best_cv_score=round(float(search.best_score_), 6),
        mean_fit_time_seconds=round(float(cv_results["mean_fit_time"][best_index]), 3),
        per_fold_scores=[round(v, 6) for v in per_fold],
    )

    fitted = search.best_estimator_

    # Test-split evaluation, on data the model has never seen.
    test_probabilities = fitted.predict_proba(prepared.x_test)[:, 1]
    test_evaluation, decile_lift = evaluate_split(
        split_name="test",
        y_true=prepared.y_test,
        probabilities=test_probabilities,
        threshold=0.5,
    )

    # Validation performance, reported separately from test performance so the
    # UI can distinguish the two rather than blending them.
    cv_probabilities = cross_val_predict_best(
        prepared=prepared,
        model_type=model_type,
        best_params=search.best_params_,
        cv_folds=usable_folds,
        random_seed=random_seed,
    )
    validation_evaluation, _ = evaluate_split(
        split_name="validation",
        y_true=prepared.y_train,
        probabilities=cv_probabilities,
        threshold=0.5,
        extra_notes=[
            "Measured on the resampled training split using out-of-fold "
            "predictions from the tuned configuration.",
            "Because SMOTE has already been applied to this split, these "
            "figures run higher than test performance. The gap is a known "
            "consequence of resampling before cross-validation.",
        ],
    )

    duration = time.perf_counter() - started
    version = uuid.uuid4().hex[:12]

    settings.artifact_dir.mkdir(parents=True, exist_ok=True)
    (settings.artifact_dir / "models").mkdir(parents=True, exist_ok=True)
    model_id = f"{model_type}-{version}"
    artifact_path = settings.artifact_dir / "models" / f"{model_id}.joblib"
    joblib.dump(
        {
            "pipeline": fitted,
            "model_type": model_type,
            "version": version,
            "preprocessing_id": preprocessing_id,
            "random_seed": random_seed,
            "trained_at": datetime.now(timezone.utc).isoformat(),
            "best_params": grid_summary.best_params,
        },
        artifact_path,
    )

    result = TrainingModelResult(
        model_type=model_type,  # type: ignore[arg-type]
        display_name=DISPLAY_NAMES[model_type],
        status="completed",
        grid_search=grid_summary,
        validation=validation_evaluation,
        test=test_evaluation,
        decile_lift=decile_lift,
        artifact_path=model_id,
        error=None,
        error_stage=None,
    )

    feature_names = [f.name for f in prepared.result.encoded_features]

    return TrainedModel(
        model_type=model_type,
        version=version,
        pipeline=fitted,
        result=result,
        feature_names=feature_names,
        preprocessing_id=preprocessing_id,
        random_seed=random_seed,
        created_at=datetime.now(timezone.utc),
        hyperparameter_count=candidates,
        extra={"train_duration_seconds": round(duration, 3)},
    )


def cross_val_predict_best(
    *,
    prepared: PreparedData,
    model_type: str,
    best_params: dict[str, Any],
    cv_folds: int,
    random_seed: int,
) -> np.ndarray:
    """Out-of-fold probabilities for the training split, using tuned params.

    The pipeline is rebuilt from scratch for every fold so SMOTE is refitted on
    that fold's training portion only.
    """
    from sklearn.base import clone
    from sklearn.model_selection import cross_val_predict

    estimator = make_estimator(model_type, random_seed)
    pipeline = build_training_pipeline(
        spec=resolve_spec(prepared.x_train),
        estimator=estimator,
        apply_smote=prepared.result.resample.applied,
        smote_random_state=random_seed,
    )
    pipeline.set_params(**best_params)

    return cross_val_predict(
        clone(pipeline),
        prepared.x_train,
        prepared.y_train,
        cv=StratifiedKFold(
            n_splits=cv_folds, shuffle=True, random_state=random_seed
        ),
        method="predict_proba",
        n_jobs=1,
    )[:, 1]


def failure_result(model_type: str, stage: str, exc: BaseException) -> TrainingModelResult:
    """Build a failed result that records what broke, without leaking internals."""
    message = str(exc).strip() or exc.__class__.__name__
    return TrainingModelResult(
        model_type=model_type,  # type: ignore[arg-type]
        display_name=DISPLAY_NAMES.get(model_type, model_type),
        status="failed",
        grid_search=GridSearchSummary(
            scoring_metric="roc_auc",
            cv_folds=0,
            cv_strategy="not run",
            candidates_evaluated=0,
            best_params={},
            best_cv_score=0.0,
            mean_fit_time_seconds=0.0,
        ),
        validation=ModelEvaluation(
            split="validation_cv",
            sample_size=0,
            positive_count=0,
            evaluated_at=datetime.now(timezone.utc),
            notes=["Training did not complete, so no metrics are available."],
        ),
        test=None,
        decile_lift=None,
        artifact_path=None,
        error=message,
        error_stage=stage,
    )


def failure_diagnostics(exc: BaseException) -> dict[str, Any]:
    """Short diagnostic context for a failed run, safe to show an operator."""
    return {
        "exception_type": exc.__class__.__name__,
        "last_frame": traceback.format_exc().strip().splitlines()[-3:],
    }
