-- Record who loaded a dataset's customer rows.
--
-- Customer rows arrive from an uploaded file, so "where did this row come from"
-- is a real question: which dataset, and loaded by whom. The dataset is already
-- a foreign key; the person was not recorded at all, because the insert that
-- passes the actor had no column to put it in.

ALTER TABLE customers
  ADD COLUMN loaded_by uuid REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN customers.loaded_by IS
  'The account that loaded these rows from the dataset file. Null once the user is removed.';
