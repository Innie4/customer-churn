"""End-to-end smoke test of the real ML pipeline.

Runs the documented workflow against the sample dataset and prints what actually
happened. Used to verify the service during development and as a manual check
that no stage is simulated.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np

from app.config import ensure_artifact_dir
from app.pipeline.explainability import (
    background_sample,
    global_explanation,
    local_explanation,
)
from app.pipeline.inspection import inspect_dataset
from app.pipeline.preprocessing import PreprocessParams, preprocess

DATA = Path(__file__).resolve().parents[2] / "sample-data" / "Telco-Customer-Churn.csv"


def main() -> int:
    ensure_artifact_dir()
    raw = DATA.read_bytes()

    print("=" * 72)
    print("1. INSPECTION")
    print("=" * 72)
    report = inspect_dataset(
        raw, filename=DATA.name, target_column="Churn", id_columns=["customerID"]
    )
    print(f"rows={report.row_count} cols={report.column_count} "
          f"target={report.target_column} churn={report.target_positive_rate:.4%}")
    print(f"duplicates={report.duplicate_row_count} "
          f"totalcharges_blanks={report.total_charges_blank_rows} "
          f"(zero-tenure: {report.total_charges_blank_with_zero_tenure})")
    print("issues:")
    for issue in report.issues:
        print(f"  [{issue.severity:7}] {issue.code}: {issue.message}")
    blocking = [i for i in report.issues if i.severity == "error"]
    if blocking:
        print("BLOCKING ISSUES PRESENT - stopping")
        return 1

    print()
    print("=" * 72)
    print("2. PREPROCESSING")
    print("=" * 72)
    params = PreprocessParams(
        target_column="Churn", id_columns=["customerID"], test_size=0.2, stratify=True
    )
    prepared = preprocess(
        inspect_frame(raw), params, source_filename=DATA.name
    )
    result = prepared.result
    for step in result.steps:
        print(f"  - {step.step}: {step.description[:78]}")
        print(f"      rows {step.rows_in} -> {step.rows_out}")
    print(f"  split: train={result.split.train_rows} test={result.split.test_rows} "
          f"train_churn={result.split.train_churn_rate:.4%} "
          f"test_churn={result.split.test_churn_rate:.4%}")
    print(f"  SMOTE: applied={result.resample.applied} "
          f"rows {result.resample.rows_before} -> {result.resample.rows_after}")
    print(f"  encoded features: {result.encoded_feature_count}")
    print(f"  warnings: {result.warnings}")
    print(f"  preprocessing_id={result.preprocessing_id}")

    expected = 5634, 1409
    actual = result.split.train_rows, result.split.test_rows
    print(f"  split check: expected {expected}, got {actual} "
          f"{'OK' if expected == actual else 'MISMATCH'}")
    smote_expected = 8278
    print(f"  SMOTE check: expected {smote_expected}, got {result.resample.rows_after} "
          f"{'OK' if result.resample.rows_after == smote_expected else 'MISMATCH'}")

    print()
    print("=" * 72)
    print("3. TRAINING (real grid search, 5-fold stratified CV)")
    print("=" * 72)
    from app.pipeline.training import train_single_model

    trained: dict[str, object] = {}
    for model_type in ("logistic_regression", "random_forest", "xgboost"):
        started = time.perf_counter()
        model = train_single_model(
            prepared,
            model_type,
            preprocessing_id=result.preprocessing_id,
            cv_folds=5,
            random_seed=42,
        )
        elapsed = time.perf_counter() - started
        trained[model_type] = model
        r = model.result
        print(f"\n  {r.display_name}  ({elapsed:.1f}s)")
        print(f"    best params: {r.grid_search.best_params}")
        print(f"    CV AUC-ROC : {r.grid_search.best_cv_score:.4f} "
              f"(folds: {[round(s, 4) for s in r.grid_search.per_fold_scores]})")
        if r.test and r.test.metrics:
            m = r.test.metrics
            cm = r.test.confusion_matrix
            print(f"    TEST acc={m.accuracy:.4f} prec={m.precision:.4f} "
                  f"rec={m.recall:.4f} f1={m.f1:.4f} auc={m.roc_auc:.4f}")
            print(f"    TEST confusion: TN={cm.true_negative} FP={cm.false_positive} "
                  f"FN={cm.false_negative} TP={cm.true_positive} (n={cm.total})")
        if r.decile_lift:
            top = r.decile_lift.rows[0]
            print(f"    decile 1 lift: {top.lift}x (churn {top.churn_rate:.1%}), "
                  f"top 20% captures {r.decile_lift.rows[1].cumulative_captured:.1%}")

    print()
    print("=" * 72)
    print("4. PREDICTION (raw features through the fitted pipeline)")
    print("=" * 72)
    model = trained["logistic_regression"]
    probabilities = model.pipeline.predict_proba(prepared.x_test)[:, 1]
    print(f"  test rows scored: {len(probabilities)}")
    print(f"  mean probability: {probabilities.mean():.4f}")
    print(f"  max: {probabilities.max():.4f}  min: {probabilities.min():.4f}")

    print()
    print("=" * 72)
    print("5. SHAP")
    print("=" * 72)
    feature_names = [f.name for f in result.encoded_features]
    encoded_test = np.asarray(
        model.pipeline.named_steps["preprocess"].transform(prepared.x_test),
        dtype=np.float64,
    )
    sample = encoded_test[:1000]
    background = background_sample(sample, size=100)

    xgb = trained["xgboost"]
    glob = global_explanation(
        model_type="xgboost",
        pipeline=xgb.pipeline,
        encoded_matrix=sample,
        features=result.encoded_features,
        feature_names=feature_names,
        model_id=xgb.model_id if hasattr(xgb, "model_id") else "xgboost-smoke",
        model_version=xgb.version,
        background=background,
    )
    print(f"  global sample size: {glob.sample_size}")
    print("  top 5 drivers:")
    for row in glob.features[:5]:
        print(f"    {row.rank}. {row.label:34} mean|SHAP|={row.mean_abs_shap:.4f} "
              f"({row.direction})")

    print("\n  local explanation, highest-risk customer:")
    riskiest = int(np.argmax(probabilities))
    local = local_explanation(
        model_type="xgboost",
        pipeline=xgb.pipeline,
        encoded_row=encoded_test[riskiest].reshape(1, -1),
        features=result.encoded_features,
        feature_names=feature_names,
        background=background,
        model_id="xgboost-smoke",
        model_version=xgb.version,
        row_index=riskiest,
    )
    print(f"    probability: {local.churn_probability:.4f} "
          f"base_value: {local.base_value:.4f}")
    print(f"    summary: {local.summary[:200]}")
    print("    top increasing risk:")
    for c in local.top_increasing_risk:
        print(f"      +{c.shap_value:.4f}  {c.label} ({c.value})")
    print("    top reducing risk:")
    for c in local.top_reducing_risk:
        print(f"      {c.shap_value:+.4f}  {c.label} ({c.value})")

    print()
    print("=" * 72)
    print("PIPELINE OK")
    print("=" * 72)
    return 0


def inspect_frame(raw: bytes):
    from app.pipeline.inspection import read_dataset

    return read_dataset(raw, "Telco-Customer-Churn.csv")


if __name__ == "__main__":
    raise SystemExit(main())
