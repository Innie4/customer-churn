"""Training run manager.

Training takes real time, so runs are executed on a worker thread and polled by
the application. That gives the interface the honest progression
queued -> running -> evaluating -> completed, and means a slow run never blocks
an HTTP request or times a browser session out.

Failed runs are kept. A run that failed is a record with a stage and a reason,
which is what the model history page needs to show.
"""

from __future__ import annotations

import threading
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any

import numpy as np
import pandas as pd

from .config import SUPPORTED_MODEL_TYPES, settings
from .pipeline import training
from .pipeline.preprocessing import PreparedData, PreprocessingError, clean_frame
from .pipeline.plots import (
    plot_confusion_matrix,
    plot_decile_lift,
    plot_roc,
    plot_shap_beeswarm,
    plot_shap_importance,
)
from .schemas import (
    GlobalExplanation,
    TrainingModelResult,
    TrainingRunRequest,
    TrainingRunStatus,
)
from .store import model_store, utcnow_iso, write_json

#: A single worker keeps concurrent grid searches from competing for CPU, which
#: would make every run slower and timings less meaningful.
_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ml-training")

_RUNS: dict[str, TrainingRunStatus] = {}
_LOCK = threading.Lock()
_MAX_RUNS = 200


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _persist_run(status: TrainingRunStatus) -> None:
    write_json(
        settings.artifact_dir / "runs" / f"{status.run_id}.json",
        status.model_dump(mode="json"),
    )


def get_run(run_id: str) -> TrainingRunStatus | None:
    with _LOCK:
        return _RUNS.get(run_id)


def list_runs() -> list[TrainingRunStatus]:
    with _LOCK:
        return sorted(_RUNS.values(), key=lambda r: r.started_at or _utcnow(), reverse=True)


def submit_run(request: TrainingRunRequest) -> TrainingRunStatus:
    """Register a run and hand it to the worker pool."""
    run_id = uuid.uuid4().hex
    status = TrainingRunStatus(
        run_id=run_id,
        status="queued",
        stage="Waiting for a training worker",
        progress_percent=0,
        preprocessing_id=request.preprocessing_id,
        label=request.run_label,
        requested_models=list(request.model_types),
    )
    with _LOCK:
        _RUNS[run_id] = status
        _evict_old_runs()
    _persist_run(status)

    _EXECUTOR.submit(_execute, run_id, request)
    return status


def _evict_old_runs() -> None:
    if len(_RUNS) <= _MAX_RUNS:
        return
    ordered = sorted(_RUNS.values(), key=lambda r: r.started_at or _utcnow())
    for stale in ordered[: len(_RUNS) - _MAX_RUNS]:
        _RUNS.pop(stale.run_id, None)


def _update(run_id: str, **changes: Any) -> TrainingRunStatus:
    with _LOCK:
        status = _RUNS[run_id]
        for key, value in changes.items():
            setattr(status, key, value)
        _persist_run(status)
        return status


def _execute(run_id: str, request: TrainingRunRequest) -> None:
    """Run every requested model family, recording progress as it goes."""
    import time

    started = time.perf_counter()
    _update(
        run_id,
        status="running",
        stage="Loading the preprocessed dataset",
        progress_percent=5,
        started_at=_utcnow(),
    )

    try:
        _preprocessor, metadata = model_store.load_preprocessing(
            request.preprocessing_id
        )
        prepared = _rebuild_prepared(request.preprocessing_id, metadata)
    except (PreprocessingError, Exception) as exc:  # noqa: BLE001
        _fail(run_id, "loading_preprocessing", exc, started)
        return

    results: list[TrainingModelResult] = []
    total = len(request.model_types)

    for index, model_type in enumerate(request.model_types):
        _update(
            run_id,
            status="running",
            stage=f"Training {training.DISPLAY_NAMES.get(model_type, model_type)}",
            progress_percent=int(10 + (70 * index / max(total, 1))),
        )
        try:
            trained = training.train_single_model(
                prepared,
                model_type,
                preprocessing_id=request.preprocessing_id,
                cv_folds=request.cv_folds,
                random_seed=request.random_seed,
            )
            _attach_plots(run_id, model_type, trained, prepared)
            results.append(trained.result)
            _update(run_id, models=list(results))
        except Exception as exc:  # noqa: BLE001 - one model must not kill the run
            results.append(training.failure_result(model_type, "training", exc))
            _update(run_id, models=list(results))

    completed = [r for r in results if r.status == "completed"]
    if not completed:
        first_error = next(
            (r.error for r in results if r.error), "no model completed"
        )
        _update(
            run_id,
            status="failed",
            stage="No model completed training",
            progress_percent=100,
            finished_at=_utcnow(),
            duration_seconds=round(time.perf_counter() - started, 3),
            models=results,
            error=first_error,
            error_stage="training",
        )
        return

    _update(
        run_id,
        status="completed",
        stage="Training complete",
        progress_percent=100,
        finished_at=_utcnow(),
        duration_seconds=round(time.perf_counter() - started, 3),
        models=results,
    )


def _fail(run_id: str, stage: str, exc: BaseException, started: float) -> None:
    import time

    _update(
        run_id,
        status="failed",
        stage=f"Failed during {stage}",
        progress_percent=100,
        finished_at=_utcnow(),
        duration_seconds=round(time.perf_counter() - started, 3),
        error=str(exc) or exc.__class__.__name__,
        error_stage=stage,
        diagnostics=training.failure_diagnostics(exc),
    )


def _rebuild_prepared(
    preprocessing_id: str, metadata: dict[str, Any]
) -> PreparedData:
    """Rebuild the exact train/test arrays the preprocessing run produced.

    The arrays themselves are not stored, only the transformer and the source
    rows, so the split is replayed with the recorded seed. Replaying rather
    than caching keeps the artifact small and the split reproducible.
    """
    import joblib
    import numpy as np
    import pandas as pd
    from sklearn.model_selection import train_test_split

    from .config import settings as _settings
    from .pipeline.preprocessing import PreprocessResult
    from .schemas import PreprocessParams

    params = PreprocessParams.model_validate(metadata["params"])
    rows = metadata.get("source_rows", [])
    if not rows:
        raise PreprocessingError(
            "loading_preprocessing",
            "The stored preprocessing run has no source rows, so the split "
            "cannot be replayed.",
        )

    frame = pd.DataFrame(rows)
    target_column = params.target_column

    # The stored rows are the ones the preprocessing run cleaned before
    # splitting, but cleaning is cheap and deterministic, so it is reapplied
    # rather than trusted. If a stored run predates the fix that persisted
    # cleaned rows, this is what keeps NaN out of the matrix SMOTE resamples.
    frame, _warnings = clean_frame(frame, params)

    y = (
        frame[target_column]
        .astype("string")
        .str.strip()
        .str.lower()
        .map({"no": 0, "yes": 1})
        .astype("int64")
    )

    id_columns = [c for c in params.id_columns if c in frame.columns]
    feature_frame = frame.drop(columns=[target_column])
    for column in id_columns:
        feature_frame = feature_frame.drop(columns=[column])

    x_train, x_test, y_train, y_test = train_test_split(
        feature_frame,
        y.to_numpy(),
        test_size=params.test_size,
        random_state=params.random_seed,
        stratify=y if params.stratify else None,
    )
    x_train = x_train.reset_index(drop=True)
    x_test = x_test.reset_index(drop=True)

    # The transformer recorded with the run is the one fitted on the training
    # split for reporting. The authoritative fitted transformer lives inside
    # each model artifact's pipeline, so predictions always use the transform
    # that was fitted alongside that model.
    preprocessor = joblib.load(
        _settings.artifact_dir / "preprocessors" / f"{preprocessing_id}.joblib"
    )

    result = PreprocessResult.model_validate(
        {
            k: v
            for k, v in metadata.items()
            if k not in {"source_rows", "source_filename", "source_sha256"}
        }
    )

    return PreparedData(
        frame=frame,
        feature_frame=feature_frame,
        target=y,
        x_train=x_train,
        x_test=x_test,
        y_train=y_train,
        y_test=y_test,
        preprocessor=preprocessor,
        result=result,
        raw_x_train=x_train,
        raw_x_test=x_test,
    )


def _attach_plots(
    run_id: str, model_type: str, trained: training.TrainedModel, prepared: PreparedData
) -> None:
    """Render the per-model charts and record their paths on the result.

    Charts are best effort. A plotting failure logs and moves on, because the
    measured metrics are the part that matters and losing a chart must not lose
    a trained model.
    """
    from .pipeline.explainability import plot_path

    result = trained.result
    if result.test is None or result.test.confusion_matrix is None:
        return

    name = f"{run_id}-{model_type}"
    try:
        matrix = result.test.confusion_matrix
        plot_confusion_matrix(
            {
                "true_negative": matrix.true_negative,
                "false_positive": matrix.false_positive,
                "false_negative": matrix.false_negative,
                "true_positive": matrix.true_positive,
            },
            plot_path(f"{name}-confusion"),
            f"{result.display_name} - test split confusion matrix",
        )
        if result.decile_lift and result.decile_lift.rows:
            plot_decile_lift(
                [row.model_dump() for row in result.decile_lift.rows],
                result.decile_lift.baseline_churn_rate,
                plot_path(f"{name}-decile"),
                f"{result.display_name} - churn rate by risk decile",
            )
    except Exception:  # noqa: BLE001
        traceback.print_exc()

    # Global SHAP views, sampled from the test split the model never saw.
    try:
        import numpy as np

        from .pipeline.explainability import _base_value, _build_explainer, _raw_values

        sample = _encode_test_split(trained, prepared)
        sample_size = min(settings.shap_sample_size, sample.shape[0])
        rng = np.random.default_rng(trained.random_seed)
        indices = rng.choice(sample.shape[0], size=sample_size, replace=False)
        sample = sample[np.sort(indices)]

        background = sample[: min(100, sample.shape[0])]
        explainer, _method, _probability = _build_explainer(
            trained.estimator, background, model_type
        )
        raw = explainer.shap_values(sample)
        shap_matrix = _raw_values(explainer, raw, sample.shape[0])

        feature_names = trained.feature_names or [
            f"f{i}" for i in range(sample.shape[1])
        ]

        plot_shap_beeswarm(
            shap_matrix,
            sample,
            feature_names,
            plot_path(f"{name}-beeswarm"),
            f"{result.display_name} - SHAP summary over {sample.shape[0]} customers",
        )
    except Exception:  # noqa: BLE001
        traceback.print_exc()


def _encode_test_split(
    trained: training.TrainedModel, prepared: PreparedData
):
    """Encode the held-out test split using the model's own fitted transformer."""
    import numpy as np

    transformer = trained.pipeline.named_steps["preprocess"]
    return np.asarray(transformer.transform(prepared.x_test), dtype=np.float64)


def build_run_roc_plot(runs: list[TrainingRunStatus], run_id: str) -> str | None:
    """Overlay the ROC curves of every completed model in a run."""
    from .pipeline.explainability import plot_path

    curves: dict[str, tuple[np.ndarray, np.ndarray, float]] = {}
    for model in runs:
        if model.status != "completed" or model.test is None or model.test.roc is None:
            continue
        fpr = np.array([point.fpr for point in model.test.roc.points])
        tpr = np.array([point.tpr for point in model.test.roc.points])
        curves[model.display_name] = (fpr, tpr, model.test.metrics.roc_auc if model.test.metrics else 0.0)
    if not curves:
        return None
    try:
        return plot_roc(curves, plot_path(f"{run_id}-roc"))
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        return None
