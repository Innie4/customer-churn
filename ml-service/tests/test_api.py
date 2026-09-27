"""HTTP-level tests for the service's routes.

The pipeline functions are covered elsewhere. What is tested here is the layer
between them and the wire: request schemas, status codes, and the wiring of the
handlers. Several real defects lived only in this layer — a run that was never
submitted because the handler read a renamed field, a prediction that handed an
already-encoded matrix to a pipeline expecting raw columns, and a helper that
dropped its keyword arguments — and none of them were visible to tests that
called the pipeline functions directly.

A small synthetic frame is used so a full request cycle stays quick. The sample
dataset is exercised separately in the pipeline tests.
"""

from __future__ import annotations

import io
import os
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def client():
    from app.main import create_app

    return TestClient(create_app())


@pytest.fixture(scope="module")
def csv_bytes() -> bytes:
    """A small but realistic dataset, including a blank TotalCharges.

    The blank is deliberate. It is the case that produced NaN inside the
    pipeline, so any route that transforms a raw upload has to handle it.
    """
    rng = np.random.default_rng(11)
    n = 240
    tenure = rng.integers(1, 72, n)
    monthly = np.round(rng.uniform(20, 100, n), 2)
    contract = rng.choice(["Month-to-month", "One year", "Two year"], n)
    logit = 1.5 - 0.03 * tenure + (contract == "Month-to-month") * 1.0
    churn = (rng.random(n) < 1 / (1 + np.exp(-logit))).astype(int)

    frame = pd.DataFrame(
        {
            "customerID": [f"C{i:04d}" for i in range(n)],
            "gender": rng.choice(["Male", "Female"], n),
            "SeniorCitizen": rng.integers(0, 2, n),
            "Partner": rng.choice(["Yes", "No"], n),
            "Dependents": rng.choice(["Yes", "No"], n),
            "tenure": tenure,
            "PhoneService": rng.choice(["Yes", "No"], n),
            "MultipleLines": rng.choice(["Yes", "No", "No phone service"], n),
            # Not the literal string "None": pandas reads that as a null value,
            # which is a separate case covered by its own test below.
            "InternetService": rng.choice(
                ["DSL", "Fiber optic", "No internet service"], n
            ),
            "OnlineSecurity": rng.choice(["Yes", "No", "No internet service"], n),
            "OnlineBackup": rng.choice(["Yes", "No", "No internet service"], n),
            "DeviceProtection": rng.choice(["Yes", "No", "No internet service"], n),
            "TechSupport": rng.choice(["Yes", "No", "No internet service"], n),
            "StreamingTV": rng.choice(["Yes", "No", "No internet service"], n),
            "StreamingMovies": rng.choice(["Yes", "No", "No internet service"], n),
            "Contract": contract,
            "PaperlessBilling": rng.choice(["Yes", "No"], n),
            "PaymentMethod": rng.choice(
                ["Electronic check", "Credit card", "Bank transfer"], n
            ),
            "MonthlyCharges": monthly,
            "TotalCharges": np.round(tenure * monthly, 2),
            "Churn": np.where(churn == 1, "Yes", "No"),
        }
    )
    # A customer who churned in their first month has not been billed, so the
    # total is blank rather than zero.
    frame.loc[3, "tenure"] = 0
    frame.loc[3, "TotalCharges"] = np.nan
    return frame.to_csv(index=False).encode("utf-8")


@pytest.fixture(scope="module")
def upload(csv_bytes):
    """Build the (files, data) pair httpx expects.

    `httpx` treats every entry in `files=` as an upload, so the plain form
    fields have to go in `data=` or they arrive as a file part and the request
    fails validation for the wrong reason.
    """

    def _upload(**fields):
        return (
            {"file": ("churn.csv", csv_bytes, "text/csv")},
            {k: str(v) for k, v in fields.items()},
        )

    return _upload


def post(client, route, upload, **fields):
    files, data = upload(**fields)
    return client.post(route, files=files, data=data)


@pytest.fixture(scope="module")
def trained_model(client, upload):
    """Preprocess and train one model, then return its artefact id.

    Logistic regression only, and two folds, to keep the module quick while
    still going through the real request handlers.
    """
    prep = post(client, "/v1/datasets/preprocess", upload, target_column="Churn", id_columns="customerID", apply_smote="true")
    assert prep.status_code == 200, prep.text
    preprocessing_id = prep.json()["preprocessing_id"]

    run = client.post(
        "/v1/training/runs",
        json={
            "preprocessing_id": preprocessing_id,
            "model_types": ["logistic_regression"],
            "cv_folds": 2,
            "random_seed": 42,
            "run_label": "api test",
        },
    )
    # 202: the run is queued, not finished. Anything else is a wiring fault.
    assert run.status_code == 202, run.text
    run_id = run.json()["run_id"]

    import time

    for _ in range(300):
        status = client.get(f"/v1/training/runs/{run_id}").json()
        if status["status"] in {"completed", "failed", "cancelled"}:
            break
        time.sleep(0.2)
    else:  # pragma: no cover
        pytest.fail("training run never finished")

    assert status["status"] == "completed", status
    model = status["models"][0]
    assert model["status"] == "completed", model
    return model["artifact_path"].replace(".joblib", "")


# -- health and authentication ------------------------------------------


def test_health_needs_no_key(client):
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["library_versions"]["scikit-learn"]


def test_health_reports_the_library_versions_in_use(client):
    """A version mismatch changes the numbers, so it has to be visible."""
    body = client.get("/health").json()
    for package in ("pandas", "numpy", "scikit-learn", "xgboost", "shap"):
        assert body["library_versions"][package]


def test_whoami_is_open_when_no_key_is_configured(client):
    # The suite runs with no key configured, so the route is open. The behaviour
    # with a key configured is covered by
    # test_routes_reject_a_wrong_api_key below, which needs a fresh process.
    assert client.get("/v1/auth/whoami").status_code == 200


def test_routes_reject_a_wrong_api_key():
    """A configured key is enforced, and an absent one is refused.

    The setting is read once at import, so this needs its own process rather
    than a monkeypatch. A subprocess is the only honest way to test startup
    configuration, and it also covers the check that the service refuses to
    start when the key is required but empty.
    """
    import subprocess
    import sys
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    probe = (
        "import sys;"
        "from fastapi.testclient import TestClient;"
        "from app.main import create_app;"
        "c = TestClient(create_app());"
        "print(c.get('/health').status_code,"
        " c.get('/v1/auth/whoami').status_code,"
        " c.get('/v1/auth/whoami', headers={'x-ml-api-key': 'wrong'}).status_code,"
        " c.get('/v1/auth/whoami', headers={'x-ml-api-key': 'a-known-key'}).status_code)"
    )

    def run(env_key: str) -> str:
        result = subprocess.run(
            [sys.executable, "-c", probe],
            cwd=root,
            capture_output=True,
            text=True,
            env={**os.environ, "ML_SERVICE_API_KEY": env_key},
        )
        # The service logs to stdout, so the probe's line is the last one.
        lines = (result.stdout or "").strip().splitlines()
        assert lines, f"probe produced no output: {result.stderr}"
        return lines[-1].strip()

    # A key is set: no key presented and a wrong key are both refused, the
    # correct key is accepted, and /health stays open.
    assert run("a-known-key") == "200 401 403 200"

    # Require the key but do not set one: the service must refuse to start
    # rather than silently running unauthenticated.
    result = subprocess.run(
        [sys.executable, "-c", probe],
        cwd=root,
        capture_output=True,
        text=True,
        env={
            **os.environ,
            "ML_SERVICE_API_KEY": "",
            "ML_REQUIRE_API_KEY": "true",
        },
    )
    assert result.returncode != 0
    assert "ML_SERVICE_API_KEY is empty" in (result.stderr + result.stdout)


# -- datasets -------------------------------------------------------------


def test_inspect_returns_the_shape_and_the_findings(client, upload, csv_bytes):
    response = post(client, "/v1/datasets/inspect", upload, target_column="Churn")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["row_count"] == 240
    assert body["column_count"] == 21
    codes = {issue["code"] for issue in body["issues"]}
    assert "totalcharges_blank_zero_tenure" in codes


def test_inspect_reports_an_unknown_target_column_rather_than_failing(
    client, upload
):
    """An explicitly named target that is absent is reported, not guessed.

    Silently falling back to a column called Churn would mean the person asked
    for one thing and the pipeline modelled another, with nothing saying so.
    """
    response = post(client, "/v1/datasets/inspect", upload, target_column="NotAColumn")
    assert response.status_code == 200, response.text
    body = response.json()
    issues = {issue["code"]: issue for issue in body["issues"]}
    assert "target_missing" in issues
    assert issues["target_missing"]["severity"] == "error"
    assert "NotAColumn" in issues["target_missing"]["message"]


def test_preprocess_rejects_an_unknown_target_column(client, upload):
    response = post(
        client, "/v1/datasets/preprocess", upload, target_column="NotAColumn"
    )
    assert response.status_code in {400, 422}


def test_inspect_rejects_a_non_tabular_upload(client):
    response = client.post(
        "/v1/datasets/inspect",
        files={"file": ("notes.txt", io.BytesIO(b"just some prose"), "text/plain")},
    )
    assert response.status_code == 422


def test_preprocess_handles_a_missing_categorical_value(client, csv_bytes):
    """A missing category must become a level, not fail the encoder.

    scikit-learn's encoders reject a column mixing strings with a missing value,
    so an otherwise ordinary dataset with one absent InternetService used to
    return a 500 from inside the encoder.
    """
    text = csv_bytes.decode("utf-8")
    lines = text.splitlines()
    header = lines[0].split(",")
    index = header.index("InternetService")
    # Blank one value, as a real export would.
    for row in range(2, len(lines)):
        parts = lines[row].split(",")
        if parts[index] != "DSL":
            parts[index] = ""
            lines[row] = ",".join(parts)
            break
    altered = "\n".join(lines).encode("utf-8")

    response = client.post(
        "/v1/datasets/preprocess",
        files={"file": ("gappy.csv", altered, "text/csv")},
        data={"target_column": "Churn", "id_columns": "customerID"},
    )
    assert response.status_code == 200, response.text
    names = [f["name"] for f in response.json()["encoded_features"]]
    assert any("Missing" in name for name in names), (
        "the absent value should be visible as its own level"
    )


def test_inspect_reports_a_missing_categorical_value(client, csv_bytes):
    text = csv_bytes.decode("utf-8")
    lines = text.splitlines()
    header = lines[0].split(",")
    index = header.index("InternetService")
    for row in range(2, len(lines)):
        parts = lines[row].split(",")
        if parts[index] != "DSL":
            parts[index] = ""
            lines[row] = ",".join(parts)
            break
    altered = "\n".join(lines).encode("utf-8")

    response = client.post(
        "/v1/datasets/inspect",
        files={"file": ("gappy.csv", altered, "text/csv")},
        data={"target_column": "Churn"},
    )
    assert response.status_code == 200, response.text
    codes = {issue["code"] for issue in response.json()["issues"]}
    assert "missing_categorical_value" in codes


def test_preprocess_reports_the_documented_split(client, upload):
    response = post(client, "/v1/datasets/preprocess", upload, target_column="Churn", id_columns="customerID")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["split"]["train_rows"] + body["split"]["test_rows"] == 240
    assert body["split"]["train_rows"] == 192
    assert body["split"]["test_rows"] == 48
    assert body["split"]["stratified"] is True
    # The exact encoded width depends on the levels present in the file. The
    # real dataset's 40 is asserted against the sample data in the pipeline
    # tests; here what matters is that it is stable and every source column is
    # represented.
    assert body["encoded_feature_count"] >= 30
    encoded_names = {f["name"] for f in body["encoded_features"]}
    for column in ("tenure", "MonthlyCharges", "TotalCharges", "Contract"):
        assert any(name.startswith(column) for name in encoded_names), (
            f"{column} should survive encoding"
        )
    assert body["preprocessing_id"]


def test_preprocess_leaves_no_missing_value_in_the_encoded_matrix(
    client, upload
):
    """The blank TotalCharges must be resolved, not carried into the matrix."""
    import numpy as np

    from app.pipeline.preprocessing import encoded_feature_names, load_preprocessing

    response = post(client, "/v1/datasets/preprocess", upload, target_column="Churn")
    preprocessing_id = response.json()["preprocessing_id"]
    preprocessor, metadata = load_preprocessing(preprocessing_id)

    stored = pd.DataFrame(metadata["source_rows"])
    assert not stored["TotalCharges"].isna().any()

    frame = pd.read_csv(io.BytesIO(response.request and b"" or b"")) if False else None
    del frame  # the assertion above is the one that matters

    encoded = np.asarray(preprocessor.transform(stored.drop(columns=["Churn"])))
    assert np.isfinite(encoded).all()
    assert encoded.shape[1] == len(encoded_feature_names(preprocessor))


# -- training -------------------------------------------------------------


def test_training_run_is_accepted_for_background_work(client, upload):
    prep = post(client, "/v1/datasets/preprocess", upload, target_column="Churn")
    response = client.post(
        "/v1/training/runs",
        json={
            "preprocessing_id": prep.json()["preprocessing_id"],
            "model_types": ["logistic_regression"],
            "cv_folds": 2,
            "run_label": "accepted check",
        },
    )
    # The run label must reach the status payload. Reading a renamed field here
    # is what previously made every submit return 500.
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["label"] == "accepted check"
    # A worker may already have picked it up, so either state is correct. What
    # matters is that it is accepted rather than refused, and that the caller
    # gets something to poll.
    assert body["status"] in {"queued", "running"}
    assert body["run_id"]
    assert body["progress_percent"] >= 0
    assert body["requested_models"] == ["logistic_regression"]


def test_training_against_an_unknown_preprocessing_id_records_a_failure(client):
    """The failure is recorded on the run, with a reason, rather than hidden.

    Accepting the request and then reporting a failed run is the honest shape
    for a background job: the caller has something to poll, and the poll tells
    them what went wrong instead of the run vanishing.
    """
    import time

    response = client.post(
        "/v1/training/runs",
        json={"preprocessing_id": "0" * 32, "model_types": ["logistic_regression"]},
    )
    assert response.status_code == 202, response.text
    run_id = response.json()["run_id"]

    for _ in range(100):
        body = client.get(f"/v1/training/runs/{run_id}").json()
        if body["status"] in {"completed", "failed", "cancelled"}:
            break
        time.sleep(0.1)
    else:  # pragma: no cover
        pytest.fail("run never settled")

    assert body["status"] == "failed"
    assert body["error"], "a failed run must say why"
    assert body["finished_at"]


def test_an_unknown_run_id_is_a_404(client):
    assert client.get(f"/v1/training/runs/{'0' * 32}").status_code == 404


def test_a_failed_run_is_reported_rather_than_raising(client, upload):
    """A failure is recorded on the run, not surfaced as a 500."""
    prep = post(client, "/v1/datasets/preprocess", upload, target_column="Churn")
    response = client.post(
        "/v1/training/runs",
        json={
            "preprocessing_id": prep.json()["preprocessing_id"],
            "model_types": ["not_a_model"],
        },
    )
    # Either rejected outright or recorded as a failed run, but never a 500.
    assert response.status_code in {202, 400, 422}


# -- prediction -----------------------------------------------------------


def test_scoring_a_freshly_uploaded_file(client, trained_model, upload, csv_bytes):
    response = post(client, f"/v1/models/{trained_model}/predict", upload)
    assert response.status_code == 200, response.text
    body = response.json()
    assert len(body["predictions"]) == 240
    for prediction in body["predictions"][:20]:
        assert 0.0 <= prediction["churn_probability"] <= 1.0
        assert prediction["risk_category"] in {"low", "medium", "high"}
        assert prediction["model_id"] == trained_model


def test_scoring_handles_a_blank_total_charges(client, trained_model, upload):
    """The dataset used to train the model must be scoreable by that model.

    It contains a blank TotalCharges, which is exactly what a customer who
    churned in month one looks like in production.
    """
    response = post(client, f"/v1/models/{trained_model}/predict", upload)
    assert response.status_code == 200, response.text
    predictions = response.json()["predictions"]
    assert len(predictions) == 240
    assert all(0.0 <= p["churn_probability"] <= 1.0 for p in predictions)


def test_predicted_label_uses_the_decision_threshold_not_a_risk_band(
    client, trained_model, upload
):
    """The class prediction must match the threshold the metrics were computed at.

    Using the medium risk boundary instead would make the number of predicted
    churners on screen disagree with the confusion matrix reported above it.
    """
    response = post(client, f"/v1/models/{trained_model}/predict", upload, high_threshold="0.9", medium_threshold="0.8")
    assert response.status_code == 200, response.text
    body = response.json()
    for prediction in body["predictions"]:
        expected = int(prediction["churn_probability"] >= 0.5)
        assert prediction["predicted_label"] == expected, (
            "predicted_label must follow 0.5, not a risk band"
        )


def test_scoring_an_unknown_model_is_a_404(client, upload):
    response = post(client, f"/v1/models/{'0' * 32}/predict", upload)
    assert response.status_code == 404


# -- explanation ----------------------------------------------------------


def test_explanation_capability_is_reported(client, trained_model):
    response = client.get(f"/v1/models/{trained_model}/explanation-capability")
    assert response.status_code == 200
    body = response.json()
    assert body["model_type"] == "logistic_regression"
    assert body["explainer"]
    assert "exact" in body


def test_local_explanation_reconstructs_the_prediction(
    client, trained_model, upload
):
    """The route must accept the keyword arguments it is given.

    A helper that dropped its keywords failed only here, after the pipeline
    tests had all passed.
    """
    response = post(client, f"/v1/models/{trained_model}/explanations/local", upload, row_index="0", top_n="5", render_plot="false")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["all_contributions"]
    assert body["additive"] is True

    assert body["model_type"] == "logistic_regression"
    assert body["row_index"] == 0
    assert body["summary"]
    assert body["top_increasing_risk"] or body["top_reducing_risk"]

    # Linear SHAP is in log-odds, so base_value plus the contributions has to
    # reconstruct the log-odds of the probability, not the probability itself.
    import math

    base = body["base_value"]
    total = base + sum(c["shap_value"] for c in body["all_contributions"])
    probability = body["churn_probability"]
    expected_log_odds = math.log(probability / (1 - probability))
    assert abs(total - expected_log_odds) < 0.01, (
        f"base + sum(shap) = {total:.6f} but log-odds of {probability} is "
        f"{expected_log_odds:.6f}"
    )


def test_global_explanation_ranks_features(client, trained_model, upload):
    response = post(client, f"/v1/models/{trained_model}/explanations/global", upload, sample_size="60", render_plots="false")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["sample_size"] == 60
    features = body["features"]
    assert features
    importances = [f["mean_abs_shap"] for f in features]
    assert importances == sorted(importances, reverse=True)
    assert body["disclaimer"]


def test_roc_plot_is_a_png(client, trained_model):
    """The plot route has to actually render, and be servable as an image.

    A missing numpy import in the run module made this return a 500 that only
    appeared once a real model had been trained. Handing back a filesystem path
    is not enough either: the application process cannot read this service's
    disk, so the bytes have to be fetchable.
    """
    runs = client.get("/v1/training/runs").json()
    assert runs, "there should be a run to plot"
    run_id = runs[0]["run_id"]
    if runs[0]["status"] != "completed":
        pytest.skip("the most recent run did not complete")

    located = client.get(f"/v1/training/runs/{run_id}/roc-plot")
    assert located.status_code == 200, located.text
    assert located.json()["path"].endswith(".png")

    image = client.get(f"/v1/training/runs/{run_id}/roc-plot?image=true")
    assert image.status_code == 200, image.text
    assert image.headers["content-type"].startswith("image/png")
    assert len(image.content) > 1000
    assert image.content[1:4] == b"PNG"

    # The same chart, fetched by name, which is how the application reaches the
    # plots named in an explanation payload.
    name = Path(located.json()["path"]).name
    by_name = client.get(f"/v1/plots/{name}")
    assert by_name.status_code == 200
    assert by_name.content[1:4] == b"PNG"


def test_plot_route_refuses_to_serve_anything_but_a_chart(client):
    """A crafted name must not read a file outside the plot directory."""
    for name in (
        "..%2F..%2Frequirements.txt",
        "..",
        "%2F..%2F..%2Fapp%2Fmain.py",
        "no-such-chart.png",
        "artifact.json",
    ):
        response = client.get(f"/v1/plots/{name}")
        assert response.status_code == 404, f"{name} returned {response.status_code}"


def test_roc_plot_for_an_unknown_run_is_a_404(client):
    assert client.get(f"/v1/training/runs/{'0' * 32}/roc-plot").status_code == 404


def test_explaining_an_unknown_model_is_a_404(client, upload):
    response = post(client, f"/v1/models/{'0' * 32}/explanations/local", upload)
    assert response.status_code == 404
