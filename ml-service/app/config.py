"""Runtime configuration for the machine learning service.

Every setting is read from the environment so the service can be pointed at a
different artifact directory or given a different API key per deployment. No
secret is ever returned through an API response.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    """Immutable service settings resolved once at import time."""

    api_key: str = field(
        default_factory=lambda: os.environ.get("ML_SERVICE_API_KEY", "")
    )
    artifact_dir: Path = field(
        default_factory=lambda: Path(
            os.environ.get(
                "ML_ARTIFACT_DIR", str(REPO_ROOT / "storage" / "ml")
            )
        )
    )
    max_upload_bytes: int = field(
        default_factory=lambda: _env_int("ML_MAX_UPLOAD_BYTES", 64 * 1024 * 1024)
    )
    random_seed: int = field(
        default_factory=lambda: _env_int("ML_RANDOM_SEED", 42)
    )
    shap_sample_size: int = field(
        default_factory=lambda: _env_int("ML_SHAP_SAMPLE_SIZE", 1000)
    )
    training_timeout_seconds: int = field(
        default_factory=lambda: _env_int("ML_TRAINING_TIMEOUT_SECONDS", 1800)
    )
    #: How long a finished run's artifacts stay on disk before the sweeper
    #: removes them. Keeps the artifact directory from growing without bound.
    artifact_retention_days: int = field(
        default_factory=lambda: _env_int("ML_ARTIFACT_RETENTION_DAYS", 365)
    )
    service_version: str = "1.0.0"
    #: When true the service refuses to boot without an API key. Disabled by
    #: default so a developer can run the service locally, but production
    #: deployments should turn it on.
    require_api_key: bool = field(
        default_factory=lambda: _env_bool("ML_REQUIRE_API_KEY", False)
    )


settings = Settings()

#: Columns the documented methodology treats as numeric and standardised.
SCALED_COLUMNS: tuple[str, ...] = ("tenure", "MonthlyCharges", "TotalCharges")

#: Columns the documented methodology binary-encodes.
BINARY_CATEGORICAL_COLUMNS: tuple[str, ...] = (
    "gender",
    "Partner",
    "Dependents",
    "PhoneService",
    "PaperlessBilling",
)

#: Columns the documented methodology one-hot encodes.
MULTI_CATEGORICAL_COLUMNS: tuple[str, ...] = (
    "MultipleLines",
    "InternetService",
    "OnlineSecurity",
    "OnlineBackup",
    "DeviceProtection",
    "TechSupport",
    "StreamingTV",
    "StreamingMovies",
    "Contract",
    "PaymentMethod",
)

#: Columns that must be present for the pipeline to run at all.
REQUIRED_FEATURE_COLUMNS: tuple[str, ...] = (
    "gender",
    "SeniorCitizen",
    "Partner",
    "Dependents",
    "tenure",
    "PhoneService",
    "MultipleLines",
    "InternetService",
    "OnlineSecurity",
    "OnlineBackup",
    "DeviceProtection",
    "TechSupport",
    "StreamingTV",
    "StreamingMovies",
    "Contract",
    "PaperlessBilling",
    "PaymentMethod",
    "MonthlyCharges",
    "TotalCharges",
)

#: Acceptable target values for the binary churn label.
VALID_TARGET_VALUES: frozenset[str] = frozenset({"yes", "no"})

#: The three model families the study compares.
SUPPORTED_MODEL_TYPES: tuple[str, ...] = (
    "logistic_regression",
    "random_forest",
    "xgboost",
)


def ensure_artifact_dir() -> Path:
    """Create the artifact directory tree and return it."""
    settings.artifact_dir.mkdir(parents=True, exist_ok=True)
    (settings.artifact_dir / "preprocessors").mkdir(parents=True, exist_ok=True)
    (settings.artifact_dir / "models").mkdir(parents=True, exist_ok=True)
    (settings.artifact_dir / "plots").mkdir(parents=True, exist_ok=True)
    return settings.artifact_dir
