"""Dataset loading, structural inspection and validation.

Nothing here mutates data. The module answers three questions about an uploaded
file: what is in it, is it structurally sound, and is it fit to train on. The
answers are derived from the file itself, never from documented reference
figures for the IBM Telco dataset.
"""

from __future__ import annotations

import io
import math
from typing import Any

import numpy as np
import pandas as pd

from ..config import (
    BINARY_CATEGORICAL_COLUMNS,
    MULTI_CATEGORICAL_COLUMNS,
    REQUIRED_FEATURE_COLUMNS,
    SCALED_COLUMNS,
    VALID_TARGET_VALUES,
)
from ..schemas import (
    ColumnSummary,
    InspectionReport,
    ValidationIssue,
)

#: Cells that pandas will read as missing when keep_default_na is on.
DEFAULT_NA_VALUES = ["", " ", "NA", "N/A", "n/a", "null", "NULL", "none", "None"]

#: A column is treated as categorical rather than free text when it has at most
#: this many distinct values. Above the cut-off a column is reported as text so
#: one-hot encoding is never attempted on a free-text field.
CATEGORICAL_MAX_DISTINCT = 64

#: Every column preprocessing treats as a category.
CATEGORICAL_COLUMNS = BINARY_CATEGORICAL_COLUMNS + MULTI_CATEGORICAL_COLUMNS


class DatasetError(ValueError):
    """Raised when a file cannot be read as a tabular dataset at all."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def read_dataset(raw: bytes, filename: str) -> pd.DataFrame:
    """Parse uploaded bytes into a DataFrame.

    TotalCharges in the reference dataset arrives as text with blank cells, so
    ``keep_default_na`` is left on and the blank handling is reported later
    rather than being silently repaired here.
    """
    if not raw:
        raise DatasetError("empty_file", "The uploaded file is empty.")

    try:
        decoded = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise DatasetError(
            "not_utf8",
            "The file is not UTF-8 encoded text. Export it as UTF-8 CSV and retry.",
        ) from exc

    # Guard against a stray delimiter producing a single absurdly wide column.
    first_line = decoded.splitlines()[0] if decoded.strip() else ""
    if not first_line:
        raise DatasetError("no_header", "The file has no header row.")

    # Try every supported delimiter and keep the parse that produces the most
    # columns. A comma parse of a semicolon file yields a single column whose
    # "name" is the whole header, so column count is the right tie-breaker.
    best: tuple[int, pd.DataFrame, str] | None = None
    for delimiter in (",", ";", "\t"):
        frame = _try_read(decoded, delimiter)
        if frame is None:
            continue
        columns = int(frame.shape[1])
        if best is None or columns > best[0]:
            best = (columns, frame, delimiter)
        if columns > 1:
            break

    if best is None or best[0] <= 1:
        raise DatasetError(
            "unparseable",
            "The file could not be parsed as a delimited table. "
            "Supported delimiters are comma, semicolon and tab.",
        )

    _columns, frame, delimiter = best
    frame.attrs["delimiter"] = delimiter
    return frame


def _try_read(decoded: str, delimiter: str) -> pd.DataFrame | None:
    try:
        return pd.read_csv(
            io.StringIO(decoded),
            sep=delimiter,
            dtype_backend="numpy_nullable",
            skipinitialspace=True,
            low_memory=False,
        )
    except (pd.errors.ParserError, ValueError, UnicodeDecodeError):
        return None


def _classify(series: pd.Series) -> str:
    """Classify a column from its observed values, not from its name."""
    non_null = series.dropna()
    if non_null.empty:
        return "empty"
    if pd.api.types.is_bool_dtype(series):
        return "boolean"
    if pd.api.types.is_numeric_dtype(series):
        return "numeric"
    distinct = non_null.nunique()
    if distinct <= 2:
        return "categorical"
    if distinct <= CATEGORICAL_MAX_DISTINCT:
        return "categorical"
    return "text"


def _json_safe(value: Any) -> Any:
    """Convert numpy/pandas scalars into values FastAPI can serialise.

    Missing values of every dtype become null. `pd.NA` in particular is not a
    float and not None, so without this it reaches the serialiser and the whole
    response fails with a 500 — which is how a dataset containing a single blank
    cell could not be inspected at all.
    """
    if value is None or value is pd.NA or value is pd.NaT:
        return None
    if isinstance(value, (float, np.floating)):
        as_float = float(value)
        return None if math.isnan(as_float) else as_float
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.bool_,)):
        return bool(value)
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    if value is pd.NaT:
        return None
    return value


def _column_summary(series: pd.Series, position: int, is_target: bool) -> ColumnSummary:
    kind = _classify(series)
    non_null = series.dropna()
    null_count = int(series.isna().sum())
    total = int(len(series))

    samples: list[Any] = []
    if not non_null.empty:
        samples = [_json_safe(v) for v in non_null.unique()[:5]]

    min_value = max_value = mean_value = None
    if kind == "numeric" and not non_null.empty:
        min_value = _json_safe(non_null.min())
        max_value = _json_safe(non_null.max())
        mean_value = _json_safe(non_null.mean())

    return ColumnSummary(
        name=str(series.name),
        position=position,
        inferred_type=kind,  # type: ignore[arg-type]
        pandas_dtype=str(series.dtype),
        non_null_count=total - null_count,
        null_count=null_count,
        null_fraction=round(null_count / total, 6) if total else 0.0,
        distinct_count=int(non_null.nunique()),
        sample_values=samples,
        min_value=min_value,
        max_value=max_value,
        mean_value=mean_value,
        is_target=is_target,
    )


def _count_blank_strings(frame: pd.DataFrame) -> int:
    """Count cells that were empty strings before pandas coerced them to NA."""
    count = 0
    for column in frame.columns:
        series = frame[column]
        if series.dtype == object or str(series.dtype) in {"string", "str"}:
            count += int(series.isna().sum())
    return count


def _find_target(frame: pd.DataFrame, requested: str | None) -> str:
    if requested and requested in frame.columns:
        return requested
    for candidate in ("Churn", "churn", "Churn ", "customer_churn"):
        if candidate in frame.columns:
            return candidate
    return ""


# Conventional names for a per-customer unique key. A column matching one of
# these is treated as an identifier, which excludes it from the duplicate
# comparison below.
_ID_COLUMN_NAMES = (
    "customerid",
    "customer_id",
    "customer",
    "clientid",
    "client_id",
    "accountid",
    "account_id",
    "policyid",
    "policy_id",
    "subscriberid",
    "subscriber_id",
    "rowid",
    "row_id",
    "recordid",
    "record_id",
    "id",
)


def _detect_id_columns(frame: pd.DataFrame) -> list[str]:
    """Find a unique-key column by name, or by being unique and non-numeric.

    Name alone is not enough: a column called ``id`` that repeats is not an
    identifier and treating it as one would hide real duplicates. A name match is
    therefore confirmed against the data.
    """
    detected: list[str] = []
    for name in frame.columns:
        if name.strip().lower() not in _ID_COLUMN_NAMES:
            continue
        series = frame[name]
        if series.isna().all():
            continue
        # An identifier is either unique or categorical enough to be one. A
        # column that repeats and looks like a measure is not an identifier.
        is_unique = bool(series.is_unique)
        looks_categorical = str(series.dtype) in {"object", "string", "str"} or series.nunique(
            dropna=True
        ) <= max(2, int(len(series) * 0.05))
        if is_unique or looks_categorical:
            detected.append(name)
    return detected


def _target_distribution(series: pd.Series) -> tuple[dict[str, int], float]:
    normalised = series.astype("string").str.strip().str.lower()
    counts = normalised.value_counts(dropna=True).to_dict()
    distribution = {str(k): int(v) for k, v in counts.items()}
    total = sum(distribution.values())
    positive = distribution.get("yes", 0)
    rate = round(positive / total, 6) if total else 0.0
    return distribution, rate


def inspect_dataset(
    raw: bytes,
    filename: str,
    target_column: str | None = None,
    id_columns: list[str] | None = None,
    preview_rows: int = 10,
) -> InspectionReport:
    """Produce a full structural report for an uploaded dataset."""
    frame = read_dataset(raw, filename)
    return inspect_frame(
        frame,
        filename=filename,
        size_bytes=len(raw),
        target_column=target_column,
        id_columns=id_columns or [],
        preview_rows=preview_rows,
    )


def inspect_frame(
    frame: pd.DataFrame,
    *,
    filename: str,
    size_bytes: int,
    target_column: str | None = None,
    id_columns: list[str] | None = None,
    preview_rows: int = 10,
) -> InspectionReport:
    """Structural report for an already-parsed DataFrame."""
    id_columns = list(id_columns or [])
    # Fill in a conventional key column the caller did not name, so the duplicate
    # check compares customer records rather than whole rows including a unique
    # identifier. Anything the caller passed explicitly is kept as given.
    if not id_columns:
        id_columns = _detect_id_columns(frame)
    row_count = int(len(frame))
    column_count = int(len(frame.columns))

    issues: list[ValidationIssue] = []
    resolved_target = _find_target(frame, target_column)

    # An explicitly requested target column that is not in the file is an error,
    # not an invitation to guess. Silently falling back to a column named Churn
    # would mean the person asked for one thing and the pipeline modelled
    # another, and nothing would say so.
    if target_column and target_column not in frame.columns:
        issues.append(
            ValidationIssue(
                code="target_missing",
                severity="error",
                message=f"The target column '{target_column}' is not in the dataset.",
                detail=(
                    "Columns present: "
                    + ", ".join(str(c) for c in frame.columns[:40])
                    + ". Choose one of these, or leave the target unset to have "
                    "it detected automatically."
                ),
            )
        )

    # An empty frame or an empty column list cannot be validated further.
    if column_count == 0:
        issues.append(
            ValidationIssue(
                code="no_columns",
                severity="error",
                message="The dataset has no columns.",
                detail="A churn dataset must contain at least a target column.",
            )
        )
    if row_count == 0:
        issues.append(
            ValidationIssue(
                code="no_rows",
                severity="error",
                message="The dataset has no rows.",
                detail="Upload a file that contains at least one customer record.",
            )
        )

    columns = [
        _column_summary(frame[name], position, name == resolved_target)
        for position, name in enumerate(frame.columns)
    ]

    # Duplicate rows, ignoring identifier columns which are expected to differ.
    comparison_columns = [c for c in frame.columns if c not in id_columns]
    if comparison_columns:
        duplicate_rows = int(frame.duplicated(subset=comparison_columns).sum())
    else:  # pragma: no cover - a frame with no columns at all
        duplicate_rows = 0

    target_distribution: dict[str, int] = {}
    target_rate = 0.0
    if resolved_target and resolved_target in frame.columns:
        target_distribution, target_rate = _target_distribution(
            frame[resolved_target]
        )

    # TotalCharges blank handling, reported rather than repaired.
    blank_rows = 0
    blank_with_zero_tenure = 0
    if "TotalCharges" in frame.columns:
        blank_mask = frame["TotalCharges"].isna()
        blank_rows = int(blank_mask.sum())
        if "tenure" in frame.columns:
            tenure = pd.to_numeric(frame["tenure"], errors="coerce")
            blank_with_zero_tenure = int((blank_mask & (tenure == 0)).sum())
    elif any(name.lower() == "totalcharges" for name in map(str, frame.columns)):
        issues.append(
            ValidationIssue(
                code="totalcharges_case_mismatch",
                severity="warning",
                message="A TotalCharges column was found with unexpected casing.",
                detail="Rename it to 'TotalCharges' so the documented "
                "preprocessing applies.",
            )
        )

    issues.extend(
        _structural_issues(
            frame=frame,
            columns=columns,
            resolved_target=resolved_target,
            target_distribution=target_distribution,
            duplicate_rows=duplicate_rows,
            blank_rows=blank_rows,
            blank_with_zero_tenure=blank_with_zero_tenure,
        )
    )

    preview = _preview(frame, preview_rows)

    return InspectionReport(
        filename=filename,
        size_bytes=size_bytes,
        row_count=row_count,
        column_count=column_count,
        columns=columns,
        duplicate_row_count=duplicate_rows,
        target_column=resolved_target,
        target_distribution=target_distribution,
        target_positive_rate=target_rate,
        total_charges_blank_rows=blank_rows,
        total_charges_blank_with_zero_tenure=blank_with_zero_tenure,
        blank_string_cells=_count_blank_strings(frame),
        issues=issues,
        preview_rows=preview,
    )


def _preview(frame: pd.DataFrame, limit: int) -> list[dict[str, Any]]:
    head = frame.head(limit)
    records: list[dict[str, Any]] = []
    for _, row in head.iterrows():
        records.append({str(k): _json_safe(v) for k, v in row.items()})
    return records


def _structural_issues(
    *,
    frame: pd.DataFrame,
    columns: list[ColumnSummary],
    resolved_target: str,
    target_distribution: dict[str, int],
    duplicate_rows: int,
    blank_rows: int,
    blank_with_zero_tenure: int,
) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    present = {str(name) for name in frame.columns}

    # Target column
    if not resolved_target:
        issues.append(
            ValidationIssue(
                code="target_missing",
                severity="error",
                message="No churn target column was found.",
                detail="The dataset needs a binary column (Yes/No) naming the "
                "prediction target, for example 'Churn'.",
            )
        )
    else:
        unexpected = sorted(
            key
            for key in target_distribution
            if key not in VALID_TARGET_VALUES
        )
        if unexpected:
            issues.append(
                ValidationIssue(
                    code="target_unexpected_values",
                    severity="error",
                    column=resolved_target,
                    message="The target column contains values other than Yes/No.",
                    detail=f"Unexpected values: {', '.join(unexpected)}.",
                    affected_count=int(
                        sum(target_distribution[k] for k in unexpected)
                    ),
                )
            )
        if len(target_distribution) < 2:
            issues.append(
                ValidationIssue(
                    code="target_single_class",
                    severity="error",
                    column=resolved_target,
                    message="The target column has only one distinct value.",
                    detail="A model cannot be trained when every row shares the "
                    "same outcome.",
                )
            )
        yes = target_distribution.get("yes", 0)
        no = target_distribution.get("no", 0)
        total = yes + no
        if total and min(yes, no) / total < 0.05:
            issues.append(
                ValidationIssue(
                    code="target_severely_imbalanced",
                    severity="warning",
                    column=resolved_target,
                    message="The target column is severely imbalanced.",
                    detail=f"Only {min(yes, no)} of {total} rows belong to the "
                    "minority class. Metrics will need care.",
                )
            )

    # Required feature columns
    missing_required = [c for c in REQUIRED_FEATURE_COLUMNS if c not in present]
    if missing_required:
        issues.append(
            ValidationIssue(
                code="missing_required_columns",
                severity="error",
                message="The dataset is missing columns the pipeline requires.",
                detail=(
                    "Missing: " + ", ".join(missing_required) + ". "
                    "The documented preprocessing expects these fields."
                ),
                affected_count=len(missing_required),
            )
        )

    unknown_columns = sorted(present - set(REQUIRED_FEATURE_COLUMNS) - {resolved_target})
    if unknown_columns:
        issues.append(
            ValidationIssue(
                code="unexpected_columns",
                severity="info",
                message="The dataset contains extra columns.",
                detail="Extra: " + ", ".join(unknown_columns) + ". They will be "
                "ignored by the documented pipeline.",
                affected_count=len(unknown_columns),
            )
        )

    # Encoding coverage
    uncovered_categoricals = [
        c
        for c in BINARY_CATEGORICAL_COLUMNS + MULTI_CATEGORICAL_COLUMNS
        if c in present
        and _classify(frame[c]) not in {"categorical", "boolean"}
    ]
    if uncovered_categoricals:
        issues.append(
            ValidationIssue(
                code="unexpected_categorical_type",
                severity="warning",
                message="Some categorical columns hold unexpected value types.",
                detail=(
                    "Check these columns: " + ", ".join(uncovered_categoricals)
                ),
                affected_count=len(uncovered_categoricals),
            )
        )

    # Numeric integrity
    for column in SCALED_COLUMNS:
        if column not in present:
            continue
        series = frame[column]
        if _classify(series) != "numeric":
            issues.append(
                ValidationIssue(
                    code="numeric_column_not_numeric",
                    severity="warning",
                    column=column,
                    message=f"{column} could not be read as a number.",
                    detail="It will be coerced during preprocessing; check the "
                    "values are genuinely numeric.",
                )
            )
            continue
        numeric = pd.to_numeric(series, errors="coerce")
        coerced = int(numeric.isna().sum() - series.isna().sum())
        if coerced > 0:
            issues.append(
                ValidationIssue(
                    code="numeric_coercion_needed",
                    severity="warning",
                    column=column,
                    message=f"{column} contains values that are not numbers.",
                    detail=f"{coerced} cell(s) will be treated as missing.",
                    affected_count=coerced,
                )
            )
        if (numeric.dropna() < 0).any():
            issues.append(
                ValidationIssue(
                    code="negative_numeric_value",
                    severity="warning",
                    column=column,
                    message=f"{column} contains negative values.",
                    detail="Negative values are unusual for this dataset and may "
                    "indicate a data entry problem.",
                )
            )

    # TotalCharges blanks
    if blank_rows:
        detail = (
            f"{blank_rows} blank TotalCharges value(s) were found. "
            f"{blank_with_zero_tenure} of them belong to customers with zero "
            "tenure, which have not yet been billed."
        )
        if blank_with_zero_tenure == blank_rows:
            issues.append(
                ValidationIssue(
                    code="totalcharges_blank_zero_tenure",
                    severity="info",
                    column="TotalCharges",
                    message="Blank TotalCharges values will be set to 0.0.",
                    detail=detail,
                    affected_count=blank_rows,
                )
            )
        else:
            issues.append(
                ValidationIssue(
                    code="totalcharges_blank_unexplained",
                    severity="warning",
                    column="TotalCharges",
                    message="Some blank TotalCharges values have non-zero tenure.",
                    detail=detail + " These require review before training.",
                    affected_count=blank_rows - blank_with_zero_tenure,
                )
            )

    # Duplicates
    if duplicate_rows:
        issues.append(
            ValidationIssue(
                code="duplicate_rows",
                severity="warning",
                message="The dataset contains duplicate rows.",
                detail=f"{duplicate_rows} row(s) repeat an existing record. "
                "They are kept, but they can bias evaluation.",
                affected_count=duplicate_rows,
            )
        )

    # Missing categorical values. Reported because preprocessing will turn them
    # into an explicit level, and a person should know that is happening rather
    # than discover it later in an explanation.
    for summary in columns:
        if summary.name not in CATEGORICAL_COLUMNS or not summary.null_count:
            continue
        if summary.name == resolved_target:
            # A missing target is a blocking error handled above.
            continue
        issues.append(
            ValidationIssue(
                code="missing_categorical_value",
                severity="info",
                column=summary.name,
                message=f"{summary.name} has missing values.",
                detail=(
                    f"{summary.null_count} value(s) are absent. They will be "
                    "encoded as an explicit 'Missing' level, which keeps them "
                    "visible to the model instead of failing the encoder."
                ),
                affected_count=summary.null_count,
            )
        )

    # Null density per column
    for summary in columns:
        if summary.null_count and summary.null_fraction > 0.4:
            issues.append(
                ValidationIssue(
                    code="high_null_fraction",
                    severity="warning",
                    column=summary.name,
                    message=f"{summary.name} is more than 40% empty.",
                    detail=f"{summary.null_count} of {summary.null_count + summary.non_null_count} "
                    "values are missing.",
                    affected_count=summary.null_count,
                )
            )

    # Free-text columns that one-hot encoding must not touch
    text_columns = [c.name for c in columns if c.inferred_type == "text"]
    if text_columns:
        issues.append(
            ValidationIssue(
                code="text_columns_present",
                severity="info",
                message="Free-text columns were detected and will be excluded.",
                detail="Excluded: " + ", ".join(text_columns),
                affected_count=len(text_columns),
            )
        )

    # Ordering: errors first so the UI can lead with blocking problems.
    severity_rank = {"error": 0, "warning": 1, "info": 2}
    issues.sort(key=lambda i: (severity_rank[i.severity], i.code))
    return issues


def blocking_issues(report: InspectionReport) -> list[ValidationIssue]:
    return [issue for issue in report.issues if issue.severity == "error"]
