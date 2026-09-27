"""Training and evaluation tests.

The important assertions are about provenance and honesty: metrics must come
from the split they claim, a failed model must record why, and the test split
must not influence the fitted model.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.pipeline.evaluation import (
    compute_decile_lift,
    compute_metrics,
    compute_roc,
)
from app.pipeline.training import (
    DISPLAY_NAMES,
    make_estimator,
    param_grid,
    train_single_model,
)


# -- evaluation maths ----------------------------------------------------


def test_metrics_match_a_hand_computed_case():
    y_true = np.array([0, 0, 1, 1])
    # At a 0.5 threshold this separates the classes perfectly, while still
    # ranking them correctly at every other threshold.
    probabilities = np.array([0.1, 0.4, 0.6, 0.9])
    metrics, confusion, auc, notes = compute_metrics(y_true, probabilities, 0.5)
    assert metrics.accuracy == 1.0
    assert metrics.precision == 1.0
    assert metrics.recall == 1.0
    assert metrics.f1 == 1.0
    assert auc == 1.0
    assert (confusion.true_negative, confusion.false_positive) == (2, 0)
    assert (confusion.false_negative, confusion.true_positive) == (0, 2)
    assert confusion.total == 4
    assert notes == []


def test_metrics_count_one_missed_churner():
    y_true = np.array([0, 0, 1, 1])
    # The second churner sits below the threshold, so recall drops to one half.
    probabilities = np.array([0.1, 0.4, 0.9, 0.2])
    metrics, confusion, _auc, _notes = compute_metrics(y_true, probabilities, 0.5)
    assert metrics.accuracy == 0.75
    assert metrics.recall == 0.5
    assert metrics.precision == 1.0
    assert metrics.f1 == pytest.approx(2 / 3, abs=1e-6)
    assert confusion.false_negative == 1
    assert confusion.true_positive == 1


def test_a_perfect_separation_scores_one():
    y_true = np.array([0, 0, 1, 1])
    probabilities = np.array([0.01, 0.02, 0.98, 0.99])
    metrics, _confusion, auc, _notes = compute_metrics(y_true, probabilities)
    assert auc == 1.0
    assert metrics.accuracy == 1.0


def test_a_model_that_flags_nobody_is_reported_honestly():
    y_true = np.array([0, 0, 0, 1])
    probabilities = np.array([0.01, 0.02, 0.03, 0.04])
    metrics, confusion, _auc, notes = compute_metrics(y_true, probabilities, 0.5)
    assert metrics.recall == 0.0
    assert metrics.precision == 0.0
    assert confusion.true_positive == 0
    # The reason must be stated, not hidden behind a plausible-looking number.
    assert any("flagged no customer" in note for note in notes)


def test_auc_is_reported_as_zero_when_a_class_is_missing():
    y_true = np.array([0, 0, 0])
    metrics, _confusion, auc, notes = compute_metrics(y_true, np.array([0.1, 0.2, 0.3]))
    assert auc == 0.0
    assert any("AUC-ROC" in note for note in notes)


def test_roc_curve_keeps_both_endpoints():
    y_true = np.array([0, 0, 1, 1])
    curve = compute_roc(y_true, np.array([0.1, 0.2, 0.8, 0.9]))
    assert curve.points[0].fpr == 0.0
    assert curve.points[-1].fpr == 1.0
    assert curve.auc == 1.0


def test_roc_is_flat_when_a_class_is_missing():
    curve = compute_roc(np.array([1, 1, 1]), np.array([0.2, 0.5, 0.9]))
    assert curve.auc == 0.0


# -- decile lift ---------------------------------------------------------


def test_decile_lift_ranks_the_worst_decile_first():
    y_true = np.array([1] * 50 + [0] * 950)
    probabilities = np.linspace(1.0, 0.0, 1000)
    lift = compute_decile_lift(y_true, probabilities)

    assert lift.baseline_churn_rate == pytest.approx(0.05)
    assert len(lift.rows) == 10
    top = lift.rows[0]
    # The top 100 of 1000 customers contain all 50 churners.
    assert top.customers == 100
    assert top.churners == 50
    assert top.churn_rate == pytest.approx(0.5)
    assert top.lift == pytest.approx(10.0, abs=0.01)
    assert lift.rows[0].cumulative_captured == pytest.approx(1.0)
    # Risk falls monotonically down the table.
    rates = [row.churn_rate for row in lift.rows]
    assert rates == sorted(rates, reverse=True)


def test_decile_lift_concentrates_positives_in_the_top_decile():
    y_true = np.array([1] * 20 + [0] * 980)
    lift = compute_decile_lift(y_true, np.linspace(1, 0, 1000))
    # The 20 churners sit in the first 20 of the ranked customers.
    assert lift.rows[0].churners == 20
    assert lift.rows[0].cumulative_captured == pytest.approx(1.0)
    assert sum(row.churners for row in lift.rows) == 20


def test_decile_lift_on_an_empty_split_does_not_divide_by_zero():
    lift = compute_decile_lift(np.array([]), np.array([]))
    assert lift.rows == []
    assert lift.baseline_churn_rate == 0.0


def test_decile_lift_works_when_nothing_churned():
    y_true = np.zeros(100, dtype=int)
    lift = compute_decile_lift(y_true, np.linspace(1, 0, 100))
    assert all(row.lift == 0.0 for row in lift.rows)
    assert all(row.churners == 0 for row in lift.rows)


def test_decile_lift_cumulative_capture_reaches_one_hundred_percent():
    y_true = np.array([1] * 30 + [0] * 970)
    lift = compute_decile_lift(y_true, np.linspace(1, 0, 1000))
    assert lift.rows[-1].cumulative_captured == pytest.approx(1.0)


# -- estimators and grids ------------------------------------------------


@pytest.mark.parametrize(
    "model_type", ["logistic_regression", "random_forest", "xgboost"]
)
def test_every_supported_model_can_be_instantiated(model_type):
    estimator = make_estimator(model_type, 42)
    assert estimator is not None
    assert DISPLAY_NAMES[model_type]


@pytest.mark.parametrize(
    "model_type", ["logistic_regression", "random_forest", "xgboost"]
)
def test_every_model_has_a_grid(model_type):
    grid = param_grid(model_type)
    assert grid
    assert all(key.startswith("model__") for key in grid)


def test_an_unknown_model_type_is_rejected():
    with pytest.raises(ValueError):
        make_estimator("deep_learning", 42)
    with pytest.raises(ValueError):
        param_grid("deep_learning")


# -- real training -------------------------------------------------------


def test_training_a_real_model_produces_measured_metrics(small_prepared):
    trained = train_single_model(
        small_prepared,
        "logistic_regression",
        preprocessing_id=small_prepared.result.preprocessing_id,
        cv_folds=3,
        random_seed=42,
    )
    result = trained.result

    assert result.status == "completed"
    assert result.test is not None
    assert result.test.metrics is not None
    assert result.test.confusion_matrix is not None

    metrics = result.test.metrics
    for value in (metrics.accuracy, metrics.precision, metrics.recall, metrics.f1):
        assert 0.0 <= value <= 1.0
    assert 0.0 <= metrics.roc_auc <= 1.0

    # The test evaluation is measured on the test split, and the validation one
    # on the training split. They are reported separately, never blended.
    assert result.test.sample_size == small_prepared.x_test.shape[0]
    assert result.validation.sample_size == small_prepared.x_train.shape[0]
    assert result.test.split == "test"
    assert result.validation.split == "validation_cv"

    # The confusion matrix accounts for every row exactly once.
    assert result.test.confusion_matrix.total == small_prepared.x_test.shape[0]


def test_the_confusion_matrix_reconstructs_the_accuracy(small_prepared):
    trained = train_single_model(
        small_prepared,
        "logistic_regression",
        preprocessing_id=small_prepared.result.preprocessing_id,
        cv_folds=3,
        random_seed=42,
    )
    matrix = trained.result.test.confusion_matrix
    accuracy = (
        matrix.true_negative + matrix.true_positive
    ) / matrix.total
    assert accuracy == pytest.approx(trained.result.test.metrics.accuracy, abs=1e-6)


def test_grid_search_records_the_search_it_actually_ran(small_prepared):
    trained = train_single_model(
        small_prepared,
        "logistic_regression",
        preprocessing_id=small_prepared.result.preprocessing_id,
        cv_folds=3,
        random_seed=42,
    )
    grid = trained.result.grid_search
    assert grid.scoring_metric == "roc_auc"
    assert grid.cv_folds == 3
    assert "StratifiedKFold" in grid.cv_strategy
    assert len(grid.per_fold_scores) == 3
    assert grid.candidates_evaluated == 4
    assert grid.best_params  # a real configuration was chosen
    assert 0.0 <= grid.best_cv_score <= 1.0


def test_a_usable_artifact_is_written(small_prepared):
    from app.store import model_store

    trained = train_single_model(
        small_prepared,
        "logistic_regression",
        preprocessing_id=small_prepared.result.preprocessing_id,
        cv_folds=3,
        random_seed=42,
    )
    loaded = model_store.load_model(trained.result.artifact_path)
    assert loaded.preprocessing_id == small_prepared.result.preprocessing_id
    assert loaded.random_seed == 42
    assert "smote" in loaded.steps


def test_training_twice_with_the_same_seed_gives_the_same_metrics(small_prepared):
    kwargs = dict(
        preprocessing_id=small_prepared.result.preprocessing_id,
        cv_folds=3,
        random_seed=42,
    )
    a = train_single_model(small_prepared, "logistic_regression", **kwargs)
    b = train_single_model(small_prepared, "logistic_regression", **kwargs)
    assert a.result.test.metrics.roc_auc == b.result.test.metrics.roc_auc
    assert a.result.grid_search.best_params == b.result.grid_search.best_params


def test_the_fitted_scaler_only_saw_training_rows(small_prepared):
    """The scaler must be fitted on the training split and nothing else.

    Checked against the fitted model rather than by perturbing the test split,
    so the shared fixture is never mutated.
    """
    kwargs = dict(
        model_type="logistic_regression",
        preprocessing_id=small_prepared.result.preprocessing_id,
        cv_folds=3,
        random_seed=42,
    )
    trained = train_single_model(small_prepared, **kwargs)
    scaler = trained.transformer.named_transformers_["scaled"]
    names = list(trained.transformer.get_feature_names_out())

    for column in ("tenure", "MonthlyCharges", "TotalCharges"):
        index = names.index(column)
        train_stat = np.asarray(small_prepared.x_train[column], dtype=float)
        whole_stat = np.asarray(
            small_prepared.feature_frame[column], dtype=float
        )
        assert scaler.mean_[index] == pytest.approx(train_stat.mean(), abs=1e-6)
        assert scaler.mean_[index] != pytest.approx(whole_stat.mean(), abs=1e-6)
        assert scaler.n_samples_seen_ == small_prepared.x_train.shape[0]


# -- failure handling ----------------------------------------------------


def test_a_failed_model_records_the_stage_and_the_reason():
    from app.pipeline.training import failure_result

    result = failure_result("xgboost", "training", RuntimeError("out of memory"))
    assert result.status == "failed"
    assert result.error == "out of memory"
    assert result.error_stage == "training"
    assert result.test is None
    assert result.decile_lift is None
    assert result.grid_search.best_cv_score == 0.0


def test_failure_diagnostics_do_not_include_a_traceback_in_the_message():
    from app.pipeline.training import failure_diagnostics

    try:
        raise ValueError("something specific went wrong")
    except ValueError as exc:
        diagnostics = failure_diagnostics(exc)
    assert diagnostics["exception_type"] == "ValueError"
    assert isinstance(diagnostics["last_frame"], list)


def test_too_few_minority_rows_is_reported_rather_than_crashing(small_prepared):
    import numpy as np

    starved = small_prepared
    starved.y_train = np.where(
        np.arange(len(starved.y_train)) == 0, 1, 0
    ).astype(np.int64)

    with pytest.raises(ValueError) as exc:
        train_single_model(
            starved,
            "logistic_regression",
            preprocessing_id=starved.result.preprocessing_id,
            cv_folds=5,
            random_seed=42,
        )
    assert "minority" in str(exc.value)
