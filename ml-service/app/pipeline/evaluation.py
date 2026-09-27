"""Model evaluation.

Computes the five documented metrics, a confusion matrix, an ROC curve, and a
decile lift table. Every number returned here is measured from predictions the
model actually produced. Nothing is assumed, defaulted, or carried over from
published research.
"""

from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
from sklearn.metrics import (
    accuracy_score,
    confusion_matrix,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
    roc_curve,
)

from ..schemas import (
    ClassMetrics,
    ConfusionMatrix,
    DecileLift,
    DecileRow,
    ModelEvaluation,
    RocCurve,
    RocPoint,
)

#: Below this many minority examples AUC-ROC is not defined, because the curve
#: has no negative class to rank against.
MIN_ROWS_FOR_AUC = 2


def _safe_metric(fn, y_true: np.ndarray, y_pred: np.ndarray, default: float = 0.0) -> float:
    try:
        return float(fn(y_true, y_pred))
    except ValueError:
        return default


def compute_metrics(
    y_true: np.ndarray,
    probabilities: np.ndarray,
    threshold: float = 0.5,
) -> tuple[ClassMetrics, ConfusionMatrix, float, list[str]]:
    """Return metrics, a confusion matrix, AUC, and any caveats.

    ``zero_division=0`` is deliberate: when a model flags nobody as churning,
    precision and F1 are genuinely undefined rather than 1.0, and reporting 0.0
    with a note is the honest option.
    """
    notes: list[str] = []
    y_true = np.asarray(y_true).astype(int)
    probabilities = np.asarray(probabilities, dtype=float)

    y_pred = (probabilities >= threshold).astype(int)

    accuracy = _safe_metric(accuracy_score, y_true, y_pred)
    precision = _safe_metric(precision_score, y_true, y_pred, default=0.0)
    recall = _safe_metric(recall_score, y_true, y_pred, default=0.0)
    f1 = _safe_metric(f1_score, y_true, y_pred, default=0.0)

    positives = int(np.sum(y_true == 1))
    negatives = int(np.sum(y_true == 0))

    if positives == 0:
        notes.append(
            "The evaluation split contains no churners, so precision, recall "
            "and F1 cannot be measured and are reported as 0."
        )
    elif int(np.sum(y_pred == 1)) == 0:
        notes.append(
            "The model flagged no customer as churning at this threshold, so "
            "precision and F1 are reported as 0."
        )

    if negatives > 0 and positives > 0:
        auc = float(roc_auc_score(y_true, probabilities))
    else:
        auc = 0.0
        notes.append(
            "AUC-ROC needs both classes present in the split and is reported as 0."
        )

    matrix = confusion_matrix(y_true, y_pred, labels=[0, 1])
    confusion = ConfusionMatrix(
        true_negative=int(matrix[0, 0]),
        false_positive=int(matrix[0, 1]),
        false_negative=int(matrix[1, 0]),
        true_positive=int(matrix[1, 1]),
    )

    return (
        ClassMetrics(
            accuracy=round(accuracy, 6),
            precision=round(precision, 6),
            recall=round(recall, 6),
            f1=round(f1, 6),
            roc_auc=round(auc, 6),
        ),
        confusion,
        round(auc, 6),
        notes,
    )


def compute_roc(y_true: np.ndarray, probabilities: np.ndarray) -> RocCurve:
    """Sample the ROC curve, always including both endpoints."""
    y_true = np.asarray(y_true).astype(int)
    probabilities = np.asarray(probabilities, dtype=float)

    negatives = int(np.sum(y_true == 0))
    positives = int(np.sum(y_true == 1))

    if negatives == 0 or positives == 0:
        return RocCurve(
            points=[RocPoint(fpr=0.0, tpr=0.0, threshold=1.0)],
            auc=0.0,
        )

    fpr, tpr, thresholds = roc_curve(y_true, probabilities)
    # Down-sample very long curves so the payload stays reasonable while
    # preserving the shape and the exact endpoints.
    max_points = 200
    if len(fpr) > max_points:
        indices = np.unique(
            np.linspace(0, len(fpr) - 1, max_points).astype(int)
        )
        fpr, tpr, thresholds = fpr[indices], tpr[indices], thresholds[indices]

    points = [
        RocPoint(
            fpr=round(float(f), 6),
            tpr=round(float(t), 6),
            threshold=round(float(thr), 6) if np.isfinite(thr) else 1.0,
        )
        for f, t, thr in zip(fpr, tpr, thresholds)
    ]
    return RocCurve(points=points, auc=round(float(roc_auc_score(y_true, probabilities)), 6))


def compute_decile_lift(
    y_true: np.ndarray, probabilities: np.ndarray, deciles: int = 10
) -> DecileLift:
    """Rank customers by predicted risk and report churn rate per decile.

    This is the business-facing view: if the team can only contact the top
    slice of the base, how many real churners are in it?
    """
    y_true = np.asarray(y_true).astype(int)
    probabilities = np.asarray(probabilities, dtype=float)

    n = len(y_true)
    if n == 0:
        return DecileLift(
            deciles=deciles, baseline_churn_rate=0.0, rows=[]
        )

    baseline = float(np.mean(y_true))
    order = np.argsort(-probabilities, kind="stable")
    sorted_labels = y_true[order]

    rows: list[DecileRow] = []
    captured = 0
    total_positives = int(np.sum(y_true))

    for index in range(deciles):
        start = int(round(index * n / deciles))
        end = int(round((index + 1) * n / deciles))
        # A very small split can produce an empty band; skip rather than
        # reporting a division by zero.
        if end <= start:
            continue
        chunk = sorted_labels[start:end]
        customers = int(len(chunk))
        churners = int(np.sum(chunk))
        rate = churners / customers
        captured += churners
        rows.append(
            DecileRow(
                decile=index + 1,
                customers=customers,
                churners=churners,
                churn_rate=round(rate, 6),
                lift=round(rate / baseline, 4) if baseline > 0 else 0.0,
                cumulative_captured=round(
                    captured / total_positives, 6
                )
                if total_positives
                else 0.0,
            )
        )

    return DecileLift(
        deciles=len(rows),
        baseline_churn_rate=round(baseline, 6),
        rows=rows,
    )


def evaluate_split(
    *,
    split_name: str,
    y_true: np.ndarray,
    probabilities: np.ndarray,
    threshold: float = 0.5,
    extra_notes: list[str] | None = None,
) -> tuple[ModelEvaluation, DecileLift]:
    """Evaluate one data split and return the evaluation plus its lift table."""
    metrics, confusion, auc, notes = compute_metrics(y_true, probabilities, threshold)
    evaluation = ModelEvaluation(
        split="test" if split_name == "test" else "validation_cv",
        sample_size=int(len(y_true)),
        positive_count=int(np.sum(np.asarray(y_true).astype(int))),
        metrics=metrics,
        confusion_matrix=confusion,
        roc=compute_roc(y_true, probabilities),
        threshold=threshold,
        evaluated_at=datetime.now(timezone.utc),
        notes=notes + list(extra_notes or []),
    )
    lift = compute_decile_lift(y_true, probabilities)
    return evaluation, lift
