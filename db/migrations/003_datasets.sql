-- 003_datasets.sql
-- Uploaded churn datasets, their column structure and their validation result.
--
-- A dataset is never edited in place. Uploading a corrected file creates a new
-- row, so a model trained on an earlier file stays traceable to that exact
-- file's bytes and sha256.

CREATE TABLE datasets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text        NOT NULL,
  original_filename text        NOT NULL,
  -- Path relative to the storage root. Never an absolute path from user input.
  storage_path      text        NOT NULL,
  storage_provider  text        NOT NULL DEFAULT 'local'
                    CHECK (storage_provider IN ('local', 's3')),
  size_bytes        bigint      NOT NULL CHECK (size_bytes > 0),
  sha256            text        NOT NULL,
  mime_type         text        NOT NULL DEFAULT 'text/csv',
  status            text        NOT NULL DEFAULT 'uploaded'
                    CHECK (status IN (
                      'uploaded', 'inspecting', 'validated', 'invalid',
                      'preprocessing', 'preprocessed', 'training', 'ready', 'failed'
                    )),
  target_column     text,
  row_count         integer CHECK (row_count IS NULL OR row_count >= 0),
  column_count      integer CHECK (column_count IS NULL OR column_count >= 0),
  target_distribution jsonb,
  target_positive_rate numeric(7,6),
  duplicate_row_count integer,
  total_charges_blank_rows integer,
  latest_validation_id uuid,
  uploaded_by       uuid        REFERENCES users(id) ON DELETE SET NULL,
  deleted_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT datasets_name_length CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT datasets_positive_rate_range
    CHECK (target_positive_rate IS NULL
           OR (target_positive_rate >= 0 AND target_positive_rate <= 1))
);

-- The same bytes must not be loaded twice under two names.
CREATE UNIQUE INDEX datasets_sha256_key ON datasets (sha256) WHERE deleted_at IS NULL;
CREATE INDEX datasets_status_idx ON datasets (status) WHERE deleted_at IS NULL;
CREATE INDEX datasets_created_idx ON datasets (created_at DESC);
CREATE INDEX datasets_uploader_idx ON datasets (uploaded_by);

CREATE TRIGGER datasets_set_updated_at
  BEFORE UPDATE ON datasets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE datasets IS
  'Uploaded churn datasets. Statistics are measured from the uploaded file, never assumed.';
COMMENT ON COLUMN datasets.sha256 IS
  'Digest of the stored bytes, so a model run can be tied to an exact file version.';

CREATE TABLE dataset_columns (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id     uuid        NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  position       integer     NOT NULL CHECK (position >= 0),
  name           text        NOT NULL,
  inferred_type  text        NOT NULL
                 CHECK (inferred_type IN ('numeric', 'boolean', 'categorical', 'text', 'empty')),
  pandas_dtype   text        NOT NULL,
  non_null_count integer     NOT NULL CHECK (non_null_count >= 0),
  null_count     integer     NOT NULL CHECK (null_count >= 0),
  null_fraction  numeric(9,8) NOT NULL DEFAULT 0,
  distinct_count integer     NOT NULL CHECK (distinct_count >= 0),
  sample_values  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  min_value      double precision,
  max_value      double precision,
  mean_value     double precision,
  is_target      boolean     NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dataset_columns_unique_name UNIQUE (dataset_id, name),
  CONSTRAINT dataset_columns_unique_position UNIQUE (dataset_id, position)
);

CREATE INDEX dataset_columns_dataset_idx ON dataset_columns (dataset_id, position);
CREATE INDEX dataset_columns_target_idx ON dataset_columns (dataset_id) WHERE is_target;

COMMENT ON TABLE dataset_columns IS
  'Column structure observed at inspection time, so the dataset page does not have to re-parse the file.';

CREATE TABLE dataset_validation_results (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id     uuid        NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  -- 'pass' when nothing blocks preprocessing, 'fail' when at least one error did.
  status         text        NOT NULL CHECK (status IN ('pass', 'fail')),
  error_count    integer     NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  warning_count  integer     NOT NULL DEFAULT 0 CHECK (warning_count >= 0),
  info_count     integer     NOT NULL DEFAULT 0 CHECK (info_count >= 0),
  issues         jsonb       NOT NULL DEFAULT '[]'::jsonb,
  row_count      integer,
  column_count   integer,
  parser_used    text        NOT NULL DEFAULT 'pandas.read_csv',
  validated_by   uuid        REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX dataset_validation_dataset_idx
  ON dataset_validation_results (dataset_id, created_at DESC);
CREATE UNIQUE INDEX dataset_validation_one_per_dataset
  ON dataset_validation_results (dataset_id);

COMMENT ON TABLE dataset_validation_results IS
  'One current validation verdict per dataset. Superseded verdicts are replaced, because only the latest state of a file matters.';
