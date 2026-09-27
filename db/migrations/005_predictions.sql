-- 005_predictions.sql
-- Customers, their churn predictions and the SHAP explanations for them.
--
-- Traceability is enforced by the schema rather than left to convention: a
-- prediction names the exact model that produced it, and an explanation names
-- the exact prediction and model. A prediction cannot exist without a model.

CREATE TABLE customers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id     uuid        NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  -- The identifier carried in the source file, for example customerID.
  external_id    text        NOT NULL,
  -- One row of the source file, kept as JSON so the customer page can show the
  -- real attributes without re-reading the file.
  attributes     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  display_name   text,
  churn_label_observed integer CHECK (churn_label_observed IN (0, 1)),
  latest_prediction_id uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customers_external_id_length CHECK (char_length(external_id) BETWEEN 1 AND 200)
);

-- The same customer cannot be loaded twice from one dataset.
CREATE UNIQUE INDEX customers_dataset_external_key
  ON customers (dataset_id, external_id);
CREATE INDEX customers_dataset_idx ON customers (dataset_id);
CREATE INDEX customers_external_id_idx ON customers (external_id);
CREATE INDEX customers_observed_churn_idx ON customers (dataset_id, churn_label_observed);

CREATE TRIGGER customers_set_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE customers IS
  'Customer records loaded from a dataset, keyed by the dataset they came from.';
COMMENT ON COLUMN customers.churn_label_observed IS
  'The churn outcome stated in the source file, where present. Null for data scored without a known outcome.';

CREATE TABLE predictions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       uuid        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  model_result_id   uuid        NOT NULL REFERENCES model_results(id) ON DELETE RESTRICT,
  model_version     text        NOT NULL,
  ml_model_id       text        NOT NULL,
  churn_probability numeric(9,8) NOT NULL
                    CHECK (churn_probability >= 0 AND churn_probability <= 1),
  predicted_label   integer     NOT NULL CHECK (predicted_label IN (0, 1)),
  risk_category     text        NOT NULL
                    CHECK (risk_category IN ('low', 'medium', 'high')),
  -- The thresholds that produced the risk band travel with the prediction, so
  -- a band can always be re-derived from the stored probability.
  risk_thresholds   jsonb       NOT NULL DEFAULT '{"high":0.7,"medium":0.4}'::jsonb,
  batch_id          uuid,
  source_row_index  integer,
  predicted_at      timestamptz NOT NULL DEFAULT now(),
  created_by        uuid        REFERENCES users(id) ON DELETE SET NULL
);

-- Re-scoring a customer with the same model replaces that model's earlier
-- prediction rather than accumulating duplicates.
CREATE UNIQUE INDEX predictions_customer_model_key
  ON predictions (customer_id, model_result_id);
CREATE INDEX predictions_customer_idx ON predictions (customer_id, predicted_at DESC);
CREATE INDEX predictions_risk_idx ON predictions (risk_category, predicted_at DESC);
CREATE INDEX predictions_model_idx ON predictions (model_result_id);
CREATE INDEX predictions_batch_idx ON predictions (batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX predictions_probability_idx ON predictions (churn_probability DESC);

COMMENT ON TABLE predictions IS
  'A measured churn probability from one specific model version, with the risk band and thresholds that were in force.';
COMMENT ON COLUMN predictions.risk_category IS
  'Derived from churn_probability and the stored risk_thresholds, never set independently.';

CREATE TABLE prediction_explanations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prediction_id     uuid        NOT NULL REFERENCES predictions(id) ON DELETE CASCADE,
  model_result_id   uuid        NOT NULL REFERENCES model_results(id) ON DELETE RESTRICT,
  status            text        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'completed', 'failed')),
  explainer         text,
  is_exact          boolean,
  base_value        double precision,
  -- Plain-language summary. SHAP output is described as contribution and
  -- association, never as causation.
  summary           text,
  -- Every contribution, ranked by absolute size.
  contributions     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  top_increasing    jsonb       NOT NULL DEFAULT '[]'::jsonb,
  top_reducing     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  waterfall_plot_path text,
  -- True when the contributions were checked against the model's own
  -- probability and did not fully reconstruct it.
  additivity_warning boolean    NOT NULL DEFAULT false,
  error             text,
  error_stage       text,
  generated_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- One current explanation per prediction.
  CONSTRAINT prediction_explanations_prediction_key UNIQUE (prediction_id),
  -- A completed explanation must carry the contributions it claims to have.
  CONSTRAINT prediction_explanations_completed_has_contributions
    CHECK (status <> 'completed' OR jsonb_array_length(contributions) > 0),
  -- A failed explanation must say why.
  CONSTRAINT prediction_explanations_failed_has_error
    CHECK (status <> 'failed' OR error IS NOT NULL)
);

CREATE INDEX prediction_explanations_prediction_idx ON prediction_explanations (prediction_id);
CREATE INDEX prediction_explanations_model_idx ON prediction_explanations (model_result_id);
CREATE INDEX prediction_explanations_status_idx ON prediction_explanations (status);

CREATE TRIGGER prediction_explanations_set_updated_at
  BEFORE UPDATE ON prediction_explanations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE prediction_explanations IS
  'SHAP explanation for one prediction, traceable to the prediction and the model that produced it.';
COMMENT ON COLUMN prediction_explanations.additivity_warning IS
  'Set when the SHAP contributions did not reconstruct the predicted probability, so the interface can say the magnitudes are approximate.';
