-- 008_settings_and_integrity.sql
-- Platform settings, the deferred foreign keys that close the reference
-- cycles, and the constraints that keep the pipeline internally consistent.

CREATE TABLE app_settings (
  key         text PRIMARY KEY,
  value       jsonb       NOT NULL,
  -- Some settings change who may see what, so the change is attributable.
  updated_by  uuid        REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_settings_key_format CHECK (key ~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$')
);

CREATE TRIGGER app_settings_set_updated_at
  BEFORE UPDATE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE app_settings IS
  'Platform configuration that an operator can change, such as the risk band thresholds.';
COMMENT ON COLUMN app_settings.value IS
  'JSON document. Validated by the application layer before it is written.';

INSERT INTO app_settings (key, value) VALUES
  ('risk.thresholds', '{"high": 0.7, "medium": 0.4}'::jsonb),
  ('risk.bands', '["low", "medium", "high"]'::jsonb),
  ('ml.default_model_types', '["logistic_regression", "random_forest", "xgboost"]'::jsonb),
  ('ml.cv_folds', '5'::jsonb),
  ('ml.random_seed', '42'::jsonb),
  ('ml.smote_enabled', 'true'::jsonb),
  ('ml.test_size', '0.2'::jsonb);

-- datasets.latest_validation_id and customers.latest_prediction_id point at rows
-- that are created after the row that references them, so the constraint is
-- added here rather than inline in 003 and 005.
ALTER TABLE datasets
  ADD CONSTRAINT datasets_latest_validation_fk
  FOREIGN KEY (latest_validation_id)
  REFERENCES dataset_validation_results(id) ON DELETE SET NULL;

ALTER TABLE customers
  ADD CONSTRAINT customers_latest_prediction_fk
  FOREIGN KEY (latest_prediction_id)
  REFERENCES predictions(id) ON DELETE SET NULL;

-- Guard against a risk band that does not match the stored thresholds. The
-- application computes the band, but the constraint means a hand-edited row
-- cannot disagree with its own probability.
CREATE OR REPLACE FUNCTION prediction_risk_band_matches_thresholds()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  high double precision;
  medium double precision;
BEGIN
  high := (NEW.risk_thresholds ->> 'high')::double precision;
  medium := (NEW.risk_thresholds ->> 'medium')::double precision;

  IF high IS NULL OR medium IS NULL THEN
    RAISE EXCEPTION
      'risk_thresholds must contain numeric "high" and "medium" values';
  END IF;

  IF medium >= high THEN
    RAISE EXCEPTION
      'risk_thresholds.medium (%) must be lower than risk_thresholds.high (%)',
      medium, high;
  END IF;

  IF NEW.churn_probability >= high THEN
    IF NEW.risk_category <> 'high' THEN
      RAISE EXCEPTION
        'churn probability % is at or above the high threshold % but the risk category is %',
        NEW.churn_probability, high, NEW.risk_category;
    END IF;
  ELSIF NEW.churn_probability >= medium THEN
    IF NEW.risk_category <> 'medium' THEN
      RAISE EXCEPTION
        'churn probability % is between the thresholds but the risk category is %',
        NEW.churn_probability, NEW.risk_category;
    END IF;
  ELSE
    IF NEW.risk_category <> 'low' THEN
      RAISE EXCEPTION
        'churn probability % is below the medium threshold % but the risk category is %',
        NEW.churn_probability, medium, NEW.risk_category;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER predictions_check_risk_band
  BEFORE INSERT OR UPDATE ON predictions
  FOR EACH ROW EXECUTE FUNCTION prediction_risk_band_matches_thresholds();

COMMENT ON FUNCTION prediction_risk_band_matches_thresholds() IS
  'Ensures a stored risk category is the one its own probability and thresholds imply.';

-- Keep customers.latest_prediction_id pointing at the newest prediction, so the
-- customer list does not have to aggregate on every read.
--
-- A prediction that arrives late (a backfill, a re-run) must not displace a
-- newer one, so the pointer only moves forward in time. Ties are broken towards
-- the new row, which is the more useful of two equally recent predictions.
CREATE OR REPLACE FUNCTION refresh_customer_latest_prediction()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  -- Not "current_time": that is a SQL keyword returning the time of day, and
  -- using it as an identifier shadows the keyword inside plpgsql.
  current_predicted_at timestamptz;
BEGIN
  -- The prediction time lives on predictions, so the current pointer's time
  -- has to be read through a join rather than from customers.
  SELECT p.predicted_at
    INTO current_predicted_at
    FROM customers c
    JOIN predictions p ON p.id = c.latest_prediction_id
   WHERE c.id = NEW.customer_id;

  -- No pointer yet, or the incoming prediction is newer than the current one.
  IF current_predicted_at IS NULL
     OR current_predicted_at <= NEW.predicted_at THEN
    UPDATE customers
       SET latest_prediction_id = NEW.id
     WHERE id = NEW.customer_id
       AND (latest_prediction_id IS NULL OR latest_prediction_id <> NEW.id);
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER predictions_refresh_latest
  AFTER INSERT ON predictions
  FOR EACH ROW EXECUTE FUNCTION refresh_customer_latest_prediction();
