"""Machine learning service for the churn platform.

Exposes the real pipeline over HTTP: dataset inspection, the documented
preprocessing workflow, real model training, evaluation, prediction, and SHAP
explanations. Nothing here fabricates a metric or simulates a training run.
"""

from __future__ import annotations

import logging
import math
import sys

from fastapi import Depends, FastAPI, Request, status
from fastapi.responses import JSONResponse

from .config import ensure_artifact_dir, settings
from .routers import auth, datasets, predictions, training
from .schemas import ServiceHealth

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("ml-service")


def _json_default(value: object) -> object:
    """Last-resort JSON encoding for pandas and numpy values."""
    import numpy as np
    import pandas as pd

    if value is pd.NA or value is pd.NaT:
        return None
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        as_float = float(value)
        return None if math.isnan(as_float) else as_float
    if isinstance(value, np.bool_):
        return bool(value)
    if isinstance(value, (np.ndarray,)):
        return value.tolist()
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serialisable")


def _library_versions() -> dict[str, str]:
    import imblearn
    import matplotlib
    import numpy
    import pandas
    import shap
    import sklearn
    import xgboost

    return {
        "pandas": pandas.__version__,
        "numpy": numpy.__version__,
        "scikit-learn": sklearn.__version__,
        "imbalanced-learn": imblearn.__version__,
        "xgboost": xgboost.__version__,
        "shap": shap.__version__,
        "matplotlib": matplotlib.__version__,
    }


def create_app() -> FastAPI:
    if settings.require_api_key and not settings.api_key:
        raise RuntimeError(
            "ML_REQUIRE_API_KEY is on but ML_SERVICE_API_KEY is empty. Set a "
            "shared secret, or turn off ML_REQUIRE_API_KEY for local work."
        )

    artifact_dir = ensure_artifact_dir()
    logger.info("Artifact directory: %s", artifact_dir)
    logger.info(
        "API key authentication: %s",
        "required" if settings.api_key else "disabled (no key configured)",
    )

    app = FastAPI(
        title="Churn ML Service",
        version=settings.service_version,
        description=(
            "Preprocessing, training, evaluation, prediction and SHAP "
            "explanation for the interpretable customer churn platform."
        ),
        docs_url="/docs",
        redoc_url=None,
        # A stray pandas value must not turn a readable report into a 500.
        # Serialising it as null is the honest rendering of "no value"; the
        # pipeline functions already normalise their own output, and this is
        # the backstop for anything that slips past them.
        json_encoder=_json_default,
    )

    app.include_router(datasets.router, prefix="/v1")
    app.include_router(training.router, prefix="/v1")
    app.include_router(predictions.router, prefix="/v1")

    @app.get("/health", response_model=ServiceHealth, tags=["service"])
    async def health() -> ServiceHealth:
        """Liveness plus the exact library versions, for reproducibility."""
        return ServiceHealth(
            status="ok",
            version=settings.service_version,
            artifact_dir=str(settings.artifact_dir),
            authentication_required=bool(settings.api_key),
            library_versions=_library_versions(),
        )

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception):
        """Return a structured error without a stack trace or secret."""
        logger.exception("Unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "detail": {
                    "code": "internal_error",
                    "message": (
                        "The machine learning service hit an unexpected error. "
                        "The failure has been logged with a request reference."
                    ),
                    "path": request.url.path,
                }
            },
        )

    @app.get("/v1/auth/whoami", tags=["service"], dependencies=[Depends(auth.require_api_key)])
    async def whoami() -> dict[str, str]:
        """Confirms to the application that its key is accepted."""
        return {"status": "authorised"}

    return app


app = create_app()
