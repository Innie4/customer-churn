"""Dataset inspection and validation tests."""

from __future__ import annotations

import io

import pandas as pd
import pytest

from app.pipeline.inspection import DatasetError, inspect_dataset, read_dataset


def _csv(rows: list[dict], columns: list[str] | None = None) -> bytes:
    frame = pd.DataFrame(rows, columns=columns)
    buffer = io.StringIO()
    frame.to_csv(buffer, index=False)
    return buffer.getvalue().encode("utf-8")


# -- parsing -------------------------------------------------------------


def test_reads_a_wellformed_csv():
    raw = b"a,b\n1,2\n3,4\n"
    frame = read_dataset(raw, "test.csv")
    assert list(frame.columns) == ["a", "b"]
    assert len(frame) == 2


def test_rejects_an_empty_file():
    with pytest.raises(DatasetError) as exc:
        read_dataset(b"", "empty.csv")
    assert exc.value.code == "empty_file"


def test_rejects_a_header_only_file_with_no_columns():
    with pytest.raises(DatasetError) as exc:
        read_dataset(b"", "empty.csv")
    assert exc.value.message


def test_rejects_binary_content():
    with pytest.raises(DatasetError) as exc:
        read_dataset(b"\x00\x01\x02\xff\xfe", "binary.csv")
    assert exc.value.code in {"not_utf8", "unparseable"}


def test_reads_semicolon_delimited_files():
    frame = read_dataset(b"a;b\n1;2\n3;4\n", "semi.csv")
    assert list(frame.columns) == ["a", "b"]


def test_reads_tab_delimited_files():
    frame = read_dataset(b"a\tb\n1\t2\n", "tab.tsv")
    assert list(frame.columns) == ["a", "b"]


# -- structure reporting -------------------------------------------------


def test_reports_row_and_column_counts(sample_bytes):
    report = inspect_dataset(sample_bytes, "Telco-Customer-Churn.csv", target_column="Churn")
    assert report.row_count == 7043
    assert report.column_count == 21


def test_reports_the_churn_rate_measured_from_the_file(sample_bytes):
    report = inspect_dataset(sample_bytes, "Telco-Customer-Churn.csv", target_column="Churn")
    # Calculated from the data, not asserted against a documented constant.
    assert report.target_distribution["yes"] + report.target_distribution["no"] == 7043
    assert 0.26 < report.target_positive_rate < 0.27


def test_reports_total_charges_blanks_and_their_tenure(sample_bytes):
    report = inspect_dataset(sample_bytes, "Telco-Customer-Churn.csv", target_column="Churn")
    assert report.total_charges_blank_rows == 11
    assert report.total_charges_blank_with_zero_tenure == 11


def test_flags_duplicate_rows(sample_bytes):
    report = inspect_dataset(
        sample_bytes, "Telco-Customer-Churn.csv", target_column="Churn",
        id_columns=["customerID"],
    )
    assert report.duplicate_row_count == 22


def _customer_row(customer_id: str = "A") -> dict:
    return {
        "customerID": customer_id, "gender": "Female", "SeniorCitizen": 0,
        "Partner": "No", "Dependents": "No", "tenure": 5, "PhoneService": "Yes",
        "MultipleLines": "No", "InternetService": "DSL", "OnlineSecurity": "No",
        "OnlineBackup": "No", "DeviceProtection": "No", "TechSupport": "No",
        "StreamingTV": "No", "StreamingMovies": "No", "Contract": "Month-to-month",
        "PaperlessBilling": "Yes", "PaymentMethod": "Electronic check",
        "MonthlyCharges": 20.0, "TotalCharges": 100.0, "Churn": "No",
    }


def test_identifier_columns_are_excluded_from_duplicate_detection():
    """A conventional key column is recognised, so real repeats are visible.

    Two rows differing only by ``customerID`` are the same customer recorded
    twice. Excluding the identifier is what makes that visible, and requiring
    the operator to declare the column first hides it.
    """
    raw = _csv([_customer_row("A"), _customer_row("B")])

    # Recognised automatically, so the rows count as one duplicate.
    assert inspect_dataset(raw, "d.csv").duplicate_row_count == 1
    # Declaring it explicitly gives the same answer.
    assert (
        inspect_dataset(raw, "d.csv", id_columns=["customerID"]).duplicate_row_count == 1
    )


def test_identical_rows_including_the_identifier_are_duplicates():
    """A repeated key is a repeated record, not two customers."""
    raw = _csv([_customer_row("A"), _customer_row("A")])
    assert inspect_dataset(raw, "d.csv").duplicate_row_count == 1


def test_a_repeating_column_called_id_is_not_treated_as_an_identifier():
    """A conventional name alone is not enough to be an identifier.

    Treating a repeating measure called ``id`` as a key would silently discard
    the column from the comparison and hide genuine duplicate records.
    """
    rows = []
    for n in range(4):
        row = _customer_row()
        row["id"] = n // 2  # repeats, so it is a value rather than a key
        row["MonthlyCharges"] = 10.0 + n
        rows.append(row)
    report = inspect_dataset(_csv(rows), "d.csv")
    # All four differ in MonthlyCharges, so nothing is a duplicate.
    assert report.duplicate_row_count == 0


def test_classifies_column_types():
    n = 200
    frame = pd.DataFrame(
        {
            "num": list(range(n)),
            "cat": [["a", "b", "c"][i % 3] for i in range(n)],
            "flag": [["Yes", "No"][i % 2] for i in range(n)],
            "txt": [f"free text value number {i}" for i in range(n)],
        }
    )
    buffer = io.StringIO()
    frame.to_csv(buffer, index=False)

    report = inspect_dataset(
        buffer.getvalue().encode(), "t.csv", target_column="cat"
    )
    kinds = {c.name: c.inferred_type for c in report.columns}
    assert kinds["num"] == "numeric"
    assert kinds["cat"] == "categorical"
    assert kinds["flag"] == "categorical"
    assert kinds["txt"] == "text"


def test_a_high_cardinality_column_is_never_one_hot_encoded():
    n = 200
    frame = pd.DataFrame(
        {
            "cat": [["a", "b", "c"][i % 3] for i in range(n)],
            "txt": [f"value {i}" for i in range(n)],
        }
    )
    buffer = io.StringIO()
    frame.to_csv(buffer, index=False)
    report = inspect_dataset(buffer.getvalue().encode(), "t.csv", target_column="cat")
    assert any(i.code == "text_columns_present" for i in report.issues)


# -- validation issues ---------------------------------------------------


def _valid_row(**overrides) -> dict:
    row = {
        "customerID": "X1", "gender": "Female", "SeniorCitizen": 0, "Partner": "No",
        "Dependents": "No", "tenure": 12, "PhoneService": "Yes",
        "MultipleLines": "No", "InternetService": "DSL", "OnlineSecurity": "No",
        "OnlineBackup": "No", "DeviceProtection": "No", "TechSupport": "No",
        "StreamingTV": "No", "StreamingMovies": "No", "Contract": "One year",
        "PaperlessBilling": "No", "PaymentMethod": "Credit card",
        "MonthlyCharges": 65.0, "TotalCharges": 780.0, "Churn": "No",
    }
    row.update(overrides)
    return row


def test_missing_target_column_is_a_blocking_error():
    row = _valid_row()
    del row["Churn"]
    report = inspect_dataset(_csv([row]), "d.csv")
    codes = {i.code for i in report.issues}
    assert "target_missing" in codes
    assert any(i.severity == "error" for i in report.issues)


def test_unexpected_target_values_are_a_blocking_error():
    rows = [_valid_row(customerID=f"C{i}") for i in range(5)]
    rows[2] = _valid_row(customerID="C2", Churn="Maybe")
    report = inspect_dataset(_csv(rows), "d.csv", target_column="Churn")
    issue = next(i for i in report.issues if i.code == "target_unexpected_values")
    assert issue.severity == "error"
    assert "maybe" in (issue.detail or "").lower()
    assert issue.affected_count == 1


def test_single_class_target_is_a_blocking_error():
    report = inspect_dataset(
        _csv([_valid_row(customerID=f"C{i}", Churn="No") for i in range(4)]),
        "d.csv",
        target_column="Churn",
    )
    assert any(
        i.code == "target_single_class" and i.severity == "error" for i in report.issues
    )


def test_missing_required_columns_are_a_blocking_error():
    row = _valid_row()
    del row["Contract"]
    del row["tenure"]
    report = inspect_dataset(_csv([row]), "d.csv", target_column="Churn")
    issue = next(i for i in report.issues if i.code == "missing_required_columns")
    assert issue.severity == "error"
    assert "Contract" in issue.detail
    assert "tenure" in issue.detail


def test_duplicate_rows_produce_a_warning_not_an_error():
    row = _valid_row()
    report = inspect_dataset(
        _csv([row, dict(row)]), "d.csv", target_column="Churn"
    )
    issue = next(i for i in report.issues if i.code == "duplicate_rows")
    assert issue.severity == "warning"
    assert issue.affected_count == 1


def test_negative_numeric_values_produce_a_warning():
    report = inspect_dataset(
        _csv([_valid_row(tenure=-5)]), "d.csv", target_column="Churn"
    )
    assert any(i.code == "negative_numeric_value" for i in report.issues)


def test_blank_total_charges_with_zero_tenure_is_informational():
    report = inspect_dataset(
        _csv([_valid_row(tenure=0, TotalCharges="")]), "d.csv", target_column="Churn"
    )
    issue = next(
        i for i in report.issues if i.code == "totalcharges_blank_zero_tenure"
    )
    assert issue.severity == "info"


def test_blank_total_charges_with_tenure_is_a_warning():
    report = inspect_dataset(
        _csv([_valid_row(tenure=10, TotalCharges="")]), "d.csv", target_column="Churn"
    )
    issue = next(
        i for i in report.issues if i.code == "totalcharges_blank_unexplained"
    )
    assert issue.severity == "warning"


def test_extra_columns_are_reported_as_information():
    report = inspect_dataset(
        _csv([_valid_row(Surprise="x")]), "d.csv", target_column="Churn"
    )
    issue = next(i for i in report.issues if i.code == "unexpected_columns")
    assert issue.severity == "info"
    assert "Surprise" in issue.detail


def test_severely_imbalanced_target_is_a_warning():
    rows = [_valid_row(customerID=f"C{i}", Churn="No") for i in range(99)]
    rows.append(_valid_row(customerID="rare", Churn="Yes"))
    report = inspect_dataset(_csv(rows), "d.csv", target_column="Churn")
    assert any(i.code == "target_severely_imbalanced" for i in report.issues)


def test_errors_are_ordered_before_warnings():
    report = inspect_dataset(_csv([_valid_row(Surprise="x")]), "d.csv")
    severities = [i.severity for i in report.issues]
    rank = {"error": 0, "warning": 1, "info": 2}
    assert severities == sorted(severities, key=lambda s: rank[s])


def test_a_clean_dataset_has_no_blocking_issues():
    rows = [
        _valid_row(customerID=f"C{i}", Churn="Yes" if i % 2 == 0 else "No")
        for i in range(6)
    ]
    report = inspect_dataset(_csv(rows), "d.csv", target_column="Churn")
    assert [i for i in report.issues if i.severity == "error"] == []


def test_preview_is_bounded(sample_bytes):
    report = inspect_dataset(
        sample_bytes, "t.csv", target_column="Churn", preview_rows=3
    )
    assert len(report.preview_rows) == 3
