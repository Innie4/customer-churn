# Sample data

`Telco-Customer-Churn.csv` is the public IBM Telco Customer Churn dataset, from
<https://github.com/IBM/telco-customer-churn-on-icp4d>. It is included so the
project runs and the tests have something real to work on without a download
step.

- 7,043 rows, 21 columns
- 26.54% of customers churned
- 11 rows have a blank `TotalCharges`, all of them customers with zero tenure who
  had not yet been billed
- 22 rows repeat an earlier record once the `customerID` column is set aside

SHA-256:

```
16320c9c1ec72448db59aa0a26a0b95401046bef5d02fd3aeb906448e3055e91
```

Those quirks are deliberate test material. The blank totals exercise the
imputation step, the duplicates exercise the inspector's duplicate check, and the
class imbalance is why oversampling is applied inside the cross-validation loop
rather than before the split.

Nothing else belongs in this directory. Uploaded datasets, model artefacts and
generated reports are runtime state and are ignored by git.
