"""Dataset inspection, validation and preprocessing endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status

from ..config import settings
from ..pipeline.inspection import DatasetError, inspect_dataset, read_dataset
from ..pipeline.preprocessing import PreprocessingError, preprocess
from ..schemas import InspectionReport, PreprocessParams, PreprocessResult
from .auth import require_api_key

router = APIRouter(tags=["datasets"], dependencies=[Depends(require_api_key)])


async def _read_upload(file: UploadFile) -> bytes:
    """Read an upload, refusing anything over the configured size limit."""
    if file.filename is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The upload has no filename.",
        )

    limit = settings.max_upload_bytes
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=(
                    f"The file exceeds the {limit // (1024 * 1024)} MB limit. "
                    "Upload a smaller dataset."
                ),
            )
        chunks.append(chunk)

    if total == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The uploaded file is empty.",
        )
    return b"".join(chunks)


@router.post(
    "/datasets/inspect",
    response_model=InspectionReport,
    summary="Inspect an uploaded dataset",
)
async def inspect_upload(
    file: UploadFile = File(...),
    target_column: str | None = Form(default=None),
    id_columns: str | None = Form(default=None),
    preview_rows: int = Form(default=10, ge=0, le=100),
) -> InspectionReport:
    raw = await _read_upload(file)
    ids = [c.strip() for c in (id_columns or "").split(",") if c.strip()]
    try:
        return inspect_dataset(
            raw,
            filename=file.filename or "dataset.csv",
            target_column=target_column,
            id_columns=ids,
            preview_rows=preview_rows,
        )
    except DatasetError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": exc.code, "message": exc.message},
        ) from exc


@router.post(
    "/datasets/preprocess",
    response_model=PreprocessResult,
    summary="Run the documented preprocessing workflow",
)
async def run_preprocessing(
    file: UploadFile = File(...),
    target_column: str = Form(default="Churn"),
    id_columns: str | None = Form(default=None),
    test_size: float = Form(default=0.2, gt=0.0, lt=0.9),
    stratify: bool = Form(default=True),
    apply_smote: bool = Form(default=True),
    random_seed: int = Form(default=42),
    impute_total_charges: bool = Form(default=True),
) -> PreprocessResult:
    """Preprocess an uploaded dataset and persist the fitted transformer.

    SMOTE is applied to the training split only. The test split is returned at
    its natural class distribution so evaluation reflects real prevalence.
    """
    raw = await _read_upload(file)
    ids = [c.strip() for c in (id_columns or "").split(",") if c.strip()]

    try:
        report = inspect_dataset(
            raw,
            filename=file.filename or "dataset.csv",
            target_column=target_column,
            id_columns=ids,
        )
    except DatasetError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": exc.code, "message": exc.message},
        ) from exc

    blocking = [issue for issue in report.issues if issue.severity == "error"]
    if blocking:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "validation_failed",
                "message": (
                    "The dataset cannot be preprocessed until these problems "
                    "are fixed: "
                    + "; ".join(issue.message for issue in blocking)
                ),
                "issues": [issue.model_dump(mode="json") for issue in blocking],
            },
        )

    from ..pipeline.inspection import read_dataset as _read  # local, avoids shadowing

    try:
        frame = _read(raw, file.filename or "dataset.csv")
        params = PreprocessParams(
            # An explicitly requested target wins. The inspection above has
            # already rejected the request if that column is absent, so by this
            # point the two agree and nothing is silently substituted.
            target_column=target_column or report.target_column,
            id_columns=ids,
            test_size=test_size,
            stratify=stratify,
            apply_smote=apply_smote,
            random_seed=random_seed,
            impute_total_charges_from_zero_tenure=impute_total_charges,
        )
        prepared = preprocess(
            frame, params, source_filename=file.filename or "dataset.csv"
        )
    except PreprocessingError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "preprocessing_failed",
                "stage": exc.stage,
                "message": exc.message,
            },
        ) from exc

    return prepared.result
