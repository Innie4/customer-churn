-- 004_models.sql
-- Preprocessing runs, model runs, per-model results, artifacts and the
-- model-risk review that sits alongside the technical metrics.
--
-- A model is never overwritten. model_runs and model_results are append-only,
-- so the history page can show every model ever trained, including the ones
-- that failed and why.

CREATE TABLE preprocessing_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id          uuid        NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  -- Identifier assigned by the ML service, which owns the fitted transformer.
  ml_preprocessing_id text        NOT NULL,
  status              text        NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'completed', 'failed')),
  params              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  steps               jsonb       NOT NULL DEFAULT '[]'::jsonb,
  split               jsonb,
  resample            jsonb,
  encoded_features    jsonb       NOT NULL DEFAULT '[]'::jsonb,
  encoded_feature_count integer,
  scaler_mean         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  scaler_scale        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  warnings            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  error               text,
  error_stage         text,
  started_by          uuid        REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  CONSTRAINT preprocessing_ml_id_key UNIQUE (ml_preprocessing_id)
);

CREATE INDEX preprocessing_dataset_idx ON preprocessing_runs (dataset_id, created_at DESC);
CREATE INDEX preprocessing_status_idx ON preprocessing_runs (status);

COMMENT ON TABLE preprocessing_runs IS
  'One preprocessing pass over one dataset. The fitted transformer lives in the ML service artifact store, keyed by ml_preprocessing_id.';
COMMENT ON COLUMN preprocessing_runs.ml_preprocessing_id IS
  'Foreign reference into the ML service artifact store, not a database table.';

CREATE TABLE model_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id        uuid        NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  preprocessing_run_id uuid     NOT NULL REFERENCES preprocessing_runs(id) ON DELETE CASCADE,
  -- The ML service's run id, so the two services agree on which run this is.
  ml_run_id         text        UNIQUE,
  label             text,
  status            text        NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'running', 'evaluating', 'completed', 'failed', 'cancelled')),
  stage             text        NOT NULL DEFAULT 'Waiting for a training worker',
  progress_percent  integer     NOT NULL DEFAULT 0
                    CHECK (progress_percent BETWEEN 0 AND 100),
  requested_models  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  cv_folds          integer     NOT NULL DEFAULT 5 CHECK (cv_folds BETWEEN 2 AND 10),
  random_seed       integer     NOT NULL DEFAULT 42,
  started_at        timestamptz,
  finished_at       timestamptz,
  duration_seconds  numeric(12,3),
  error             text,
  error_stage       text,
  diagnostics       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  started_by        uuid        REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- A run that finished must say when, so "still running" is distinguishable
  -- from "crashed without reporting".
  CONSTRAINT model_runs_finished_has_timestamp
    CHECK (status NOT IN ('completed', 'failed', 'cancelled') OR finished_at IS NOT NULL)
);

CREATE INDEX model_runs_dataset_idx ON model_runs (dataset_id, created_at DESC);
CREATE INDEX model_runs_status_idx ON model_runs (status, created_at DESC);
CREATE INDEX model_runs_created_idx ON model_runs (created_at DESC);

CREATE TRIGGER model_runs_set_updated_at
  BEFORE UPDATE ON model_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE model_runs IS
  'A training run. Append-only: a new run creates a new row and never replaces an earlier one.';

CREATE TABLE model_results (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_run_id    uuid        NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,
  model_type      text        NOT NULL
                  CHECK (model_type IN ('logistic_regression', 'random_forest', 'xgboost')),
  display_name    text        NOT NULL,
  status          text        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'completed', 'failed')),
  -- Version string assigned at training time. Several runs can share a type
  -- and still be told apart by this.
  version         text,
  -- Identifier the ML service uses for its artifact: "<model_type>-<version>".
  ml_model_id     text UNIQUE,
  is_active       boolean     NOT NULL DEFAULT false,
  activated_at    timestamptz,
  activated_by    uuid        REFERENCES users(id) ON DELETE SET NULL,
  activation_reason text,
  hyperparameters jsonb       NOT NULL DEFAULT '{}'::jsonb,
  grid_search     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  validation_metrics  jsonb,
  validation_confusion jsonb,
  validation_roc       jsonb,
  test_metrics     jsonb,
  test_confusion  jsonb,
  test_roc        jsonb,
  decile_lift     jsonb,
  train_duration_seconds numeric(12,3),
  feature_count   integer,
  error           text,
  error_stage     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- A completed model must carry measured test metrics. This is the guard
  -- against a "successful" model with invented numbers.
  CONSTRAINT model_results_completed_has_metrics
    CHECK (status <> 'completed' OR (test_metrics IS NOT NULL AND test_confusion IS NOT NULL)),
  -- A failed model must say why it failed.
  CONSTRAINT model_results_failed_has_error
    CHECK (status <> 'failed' OR error IS NOT NULL),
  -- Activation metadata is all-or-nothing.
  CONSTRAINT model_results_activation_consistent
    CHECK ((is_active AND activated_at IS NOT NULL AND activated_by IS NOT NULL)
           OR (NOT is_active))
);

CREATE INDEX model_results_run_idx ON model_results (model_run_id);
CREATE INDEX model_results_type_idx ON model_results (model_type, created_at DESC);
CREATE INDEX model_results_active_idx ON model_results (is_active) WHERE is_active;
-- At most one active model per family, so a comparison is always against a
-- like-for-like alternative.
CREATE UNIQUE INDEX model_results_one_active_per_type
  ON model_results (model_type) WHERE is_active;

CREATE TRIGGER model_results_set_updated_at
  BEFORE UPDATE ON model_results
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE model_results IS
  'One trained model within a run, with the metrics actually measured on the test split.';
COMMENT ON COLUMN model_results.is_active IS
  'Whether this model currently serves predictions. Activation is a human decision, recorded with who and why.';

CREATE TABLE model_artifacts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_result_id  uuid        NOT NULL REFERENCES model_results(id) ON DELETE CASCADE,
  kind             text        NOT NULL
                   CHECK (kind IN ('model', 'confusion_plot', 'roc_plot', 'decile_plot',
                                   'beeswarm_plot', 'importance_plot', 'waterfall_plot')),
  storage_path     text        NOT NULL,
  size_bytes       bigint      CHECK (size_bytes IS NULL OR size_bytes >= 0),
  sha256           text,
  content_type     text        NOT NULL DEFAULT 'application/octet-stream',
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX model_artifacts_result_idx ON model_artifacts (model_result_id, kind);
CREATE UNIQUE INDEX model_artifacts_unique
  ON model_artifacts (model_result_id, kind, storage_path);

COMMENT ON TABLE model_artifacts IS
  'Files produced by a model: the serialised pipeline and its rendered charts.';

CREATE TABLE model_risk_reviews (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_result_id  uuid        NOT NULL REFERENCES model_results(id) ON DELETE CASCADE,
  feature          text        NOT NULL,
  -- The categories of concern the study asks a human to check for.
  concern_type     text        NOT NULL
                   CHECK (concern_type IN ('proxy_risk', 'questionable_variable',
                                           'bias_concern', 'needs_review')),
  severity         text        NOT NULL DEFAULT 'medium'
                   CHECK (severity IN ('low', 'medium', 'high')),
  mean_abs_shap    numeric(12,8),
  status           text        NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'under_review', 'accepted', 'rejected', 'mitigated')),
  notes            text,
  reviewed_by      uuid        REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT risk_review_reviewed_has_reviewer
    CHECK (status = 'open' OR reviewed_by IS NOT NULL)
);

CREATE INDEX model_risk_reviews_result_idx ON model_risk_reviews (model_result_id);
CREATE UNIQUE INDEX model_risk_reviews_unique_feature
  ON model_risk_reviews (model_result_id, feature, concern_type);

CREATE TRIGGER model_risk_reviews_set_updated_at
  BEFORE UPDATE ON model_risk_reviews
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE model_risk_reviews IS
  'Human review of model drivers for proxy risk and bias. Separate from the technical metrics on purpose: passing a test does not make a model unbiased.';
