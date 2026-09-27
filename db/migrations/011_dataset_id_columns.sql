-- Record which columns identify a customer.
--
-- The target column has a home, but the identifier columns had none, so the
-- choice made at upload was lost. Every downstream step then fell back to row
-- order: customers were keyed "row-1", "row-2", and predictions were matched
-- back by position rather than by customer. That is invisible on a small file
-- and quietly wrong on a real one.

ALTER TABLE datasets
  ADD COLUMN id_columns jsonb NOT NULL DEFAULT '[]'::jsonb;

-- A CHECK constraint cannot contain a subquery, so the element check is a
-- function. Declared immutable because it reads nothing but its argument, which
-- is what lets the constraint call it.
CREATE OR REPLACE FUNCTION jsonb_string_array_is_valid(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_typeof(value) = 'array'
     AND jsonb_array_length(value) <= 5
     AND NOT EXISTS (
       SELECT 1
       FROM jsonb_array_elements(value) AS element
       WHERE jsonb_typeof(element) <> 'string'
          OR length(element #>> '{}') = 0
          OR char_length(element #>> '{}') > 200
     );
$$;

ALTER TABLE datasets
  ADD CONSTRAINT datasets_id_columns_are_names
  CHECK (jsonb_string_array_is_valid(id_columns));

COMMENT ON FUNCTION jsonb_string_array_is_valid(jsonb) IS
  'True when the value is a jsonb array of at most five non-empty strings of 200 characters or fewer.';

COMMENT ON COLUMN datasets.id_columns IS
  'Columns that identify a customer, for example customerID. Empty means the file has no identifier, and matching falls back to row order.';

COMMENT ON COLUMN datasets.target_column IS
  'The churn column, decided at upload and used unless preprocessing overrides it.';
