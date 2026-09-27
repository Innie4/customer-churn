-- Global SHAP explanations.
--
-- A global explanation is a measured result, not a derived view: it was computed
-- from a specific sample of customers against a specific model version. Storing
-- it means the model page can show what was measured without recomputing on
-- every view, and without the numbers silently changing if the sample or the
-- model moves on.
--
-- One row per model version. Recomputing replaces the row for that version
-- rather than accumulating history, because a second explanation of the same
-- version answers the same question.

CREATE TABLE model_global_explanations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_result_id   uuid        NOT NULL REFERENCES model_results(id) ON DELETE CASCADE,
  -- The same version string `model_results.version` carries, so an explanation
  -- can never be attached to a version that does not exist.
  model_version     text        NOT NULL,
  sample_size       integer     NOT NULL CHECK (sample_size > 0),
  -- The measured per-feature values, ordered as the service returned them.
  features          jsonb       NOT NULL CHECK (jsonb_array_length(features) > 0),
  class_balance_note text,
  beeswarm_artifact_id uuid REFERENCES model_artifacts(id) ON DELETE SET NULL,
  importance_artifact_id uuid REFERENCES model_artifacts(id) ON DELETE SET NULL,
  disclaimer        text        NOT NULL,
  generated_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- One explanation per model version, so a view cannot show two answers.
  CONSTRAINT model_global_explanations_one_per_version
    UNIQUE (model_result_id, model_version)
);

CREATE INDEX model_global_explanations_model_idx
  ON model_global_explanations (model_result_id, created_at DESC);

CREATE TRIGGER model_global_explanations_set_updated_at
  BEFORE UPDATE ON model_global_explanations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE model_global_explanations IS
  'Measured global SHAP feature importance, one row per model version.';
COMMENT ON COLUMN model_global_explanations.features IS
  'Per-feature mean absolute SHAP values. Association, not causation.';
COMMENT ON COLUMN model_global_explanations.disclaimer IS
  'Stated with the values so a stored copy cannot be read without it.';
