"""Shared fixtures for the machine learning tests.

The full sample dataset is used where the test needs real structure. Smaller
synthetic frames are used where the test needs a specific, controlled shape, so
a failure points at one behaviour rather than at the data.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

SERVICE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = SERVICE_ROOT.parent
sys.path.insert(0, str(SERVICE_ROOT))

# Point artifacts at a throwaway directory before the app config is imported.
_TMP = Path(os.environ.get("PYTEST_ARTIFACT_DIR", REPO_ROOT / ".pytest-artifacts"))
os.environ.setdefault("ML_ARTIFACT_DIR", str(_TMP))

SAMPLE_CSV = REPO_ROOT / "sample-data" / "Telco-Customer-Churn.csv"


@pytest.fixture(scope="session")
def sample_bytes() -> bytes:
    if not SAMPLE_CSV.exists():
        pytest.skip(
            f"Sample dataset missing at {SAMPLE_CSV}. See README for how to "
            "obtain the IBM Telco Customer Churn dataset."
        )
    return SAMPLE_CSV.read_bytes()


@pytest.fixture(scope="session")
def sample_frame(sample_bytes: bytes):
    from app.pipeline.inspection import read_dataset

    return read_dataset(sample_bytes, SAMPLE_CSV.name)


@pytest.fixture(scope="session")
def prepared(sample_frame):
    """A real preprocessing run over the full sample dataset."""
    from app.pipeline.preprocessing import PreprocessParams, preprocess

    params = PreprocessParams(
        target_column="Churn", id_columns=["customerID"], test_size=0.2
    )
    return preprocess(sample_frame, params, source_filename=SAMPLE_CSV.name)


@pytest.fixture(scope="session")
def small_prepared():
    """A preprocessing run over a small deterministic frame.

    Training three model families on the full dataset takes about ninety
    seconds, which is too slow for a test that only needs a fitted pipeline.
    """
    import numpy as np
    import pandas as pd

    from app.pipeline.preprocessing import PreprocessParams, preprocess

    rng = np.random.default_rng(7)
    n = 400
    tenure = rng.integers(1, 72, n)
    monthly = rng.uniform(20, 100, n)
    contract = rng.choice(["Month-to-month", "One year", "Two year"], n)
    # Churn probability rises with low tenure and month-to-month contracts.
    logit = (
        2.0
        - 0.03 * tenure
        + 0.02 * monthly
        + (contract == "Month-to-month") * 1.1
    )
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
            "InternetService": rng.choice(["DSL", "Fiber optic", "None"], n),
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
            "MonthlyCharges": np.round(monthly, 2),
            "TotalCharges": np.round(tenure * monthly, 2),
            "Churn": np.where(churn == 1, "Yes", "No"),
        }
    )

    params = PreprocessParams(
        target_column="Churn", id_columns=["customerID"], test_size=0.25
    )
    return preprocess(frame, params, source_filename="synthetic.csv")
