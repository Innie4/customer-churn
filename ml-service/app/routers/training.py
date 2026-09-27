"""Training run endpoints.

Training is submitted and then polled, so the interface can show real progress
and a real failure state instead of a spinner that either hangs or lies.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse, JSONResponse, Response

from .. import runs
from ..config import settings
from ..schemas import TrainingRunRequest, TrainingRunStatus
from .auth import require_api_key

router = APIRouter(tags=["training"], dependencies=[Depends(require_api_key)])

#: Only these are served. Anything else is a request for a file that is not a
#: chart, and a chart is all this route is for.
PLOT_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp")


def png_response(path_or_name: str) -> Response:
    """Serve a chart, refusing anything outside the plot directory.

    The resolve-and-compare is the actual defence, exactly as in the storage
    layer of the application: a name that resolves outside the plot directory is
    rejected rather than served.
    """
    base = (settings.artifact_dir / "plots").resolve()
    target = Path(path_or_name)
    candidate = (target if target.is_absolute() else base / target).resolve()

    if candidate != base and base not in candidate.parents:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="That chart does not exist.",
        )
    if candidate.suffix.lower() not in PLOT_SUFFIXES:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Only rendered charts are served from here.",
        )
    if not candidate.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="That chart does not exist.",
        )
    return FileResponse(
        candidate,
        media_type="image/png",
        headers={"Cache-Control": "private, max-age=300"},
    )


@router.post(
    "/training/runs",
    response_model=TrainingRunStatus,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Submit a training run",
)
async def submit_training(request: TrainingRunRequest) -> TrainingRunStatus:
    """Queue a training run over a stored preprocessing result."""
    return runs.submit_run(request)


@router.get(
    "/training/runs",
    response_model=list[TrainingRunStatus],
    summary="List training runs, newest first",
)
async def list_training(limit: int = Query(default=25, ge=1, le=200)) -> list[TrainingRunStatus]:
    return runs.list_runs()[:limit]


@router.get(
    "/training/runs/{run_id}",
    response_model=TrainingRunStatus,
    summary="Fetch one training run",
)
async def get_training(run_id: str) -> TrainingRunStatus:
    found = runs.get_run(run_id)
    if found is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Training run '{run_id}' was not found. It may have been "
            "cleared when the ML service restarted.",
        )
    return found


@router.get(
    "/training/runs/{run_id}/roc-plot",
    summary="Render the ROC comparison chart for a run",
)
async def roc_plot(run_id: str, image: bool = Query(default=False)) -> Response:
    """Return the ROC comparison chart.

    With ``image=true`` the PNG bytes are returned. Without it, the location the
    file was written to is returned instead.

    The path is only useful when the caller shares this filesystem, which is the
    case in local development and not in a deployment where the two processes run
    on different machines. Returning the bytes is what makes the chart
    displayable at all; the path is kept for the developer running the service
    locally who wants to open the file.
    """
    found = runs.get_run(run_id)
    if found is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Training run '{run_id}' was not found.",
        )
    path = runs.build_run_roc_plot(found.models, run_id)
    if not image:
        return JSONResponse({"path": path})
    return png_response(path)


@router.get(
    "/plots/{plot_name}",
    summary="Serve a rendered chart as PNG bytes",
)
async def plot_image(plot_name: str) -> Response:
    """Serve one of this service's rendered charts.

    The explanations and run payloads carry a ``*_plot_path`` naming a file in
    this service's plot directory. The name is resolved strictly inside that
    directory, so a crafted name cannot read anything else.
    """
    return png_response(plot_name)
