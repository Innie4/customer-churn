-- 006_retention.sql
-- Retention strategies derived from model drivers, and the actions a retention
-- team actually creates and tracks.
--
-- A strategy is a model-informed suggestion for human review. An action is a
-- commitment a person made. The two are separate records because a suggestion
-- nobody acted on is a real and common outcome, not a failure.

CREATE TABLE retention_strategies (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title                 text        NOT NULL,
  description           text        NOT NULL,
  -- The condition under which this strategy is suggested for a customer.
  triggering_condition  text        NOT NULL,
  -- The model-identified driver that motivates it, e.g. "Contract: Month-to-month".
  risk_driver           text        NOT NULL,
  source_column         text,
  suggested_intervention text       NOT NULL,
  priority              text        NOT NULL DEFAULT 'medium'
                        CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  status                text        NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'proposed', 'approved', 'rejected', 'retired')),
  -- Strategy approval is a human decision and is kept distinct from the
  -- technical approval of the model itself.
  approved_by           uuid        REFERENCES users(id) ON DELETE SET NULL,
  approved_at           timestamptz,
  notes                 text,
  -- Optional link to the model whose drivers produced this strategy.
  derived_from_model_result_id uuid  REFERENCES model_results(id) ON DELETE SET NULL,
  created_by            uuid        REFERENCES users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retention_strategies_title_length
    CHECK (char_length(title) BETWEEN 3 AND 200),
  CONSTRAINT retention_strategies_approved_consistent
    CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE INDEX retention_strategies_status_idx ON retention_strategies (status);
CREATE INDEX retention_strategies_driver_idx ON retention_strategies (risk_driver);
CREATE INDEX retention_strategies_model_idx ON retention_strategies (derived_from_model_result_id);

CREATE TRIGGER retention_strategies_set_updated_at
  BEFORE UPDATE ON retention_strategies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE retention_strategies IS
  'Model-informed retention suggestions awaiting human review. Not a guarantee of any outcome.';
COMMENT ON COLUMN retention_strategies.status IS
  'Approval state of the strategy itself, separate from whether the model was approved for use.';

CREATE TABLE customer_retention_actions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    uuid        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  prediction_id  uuid        REFERENCES predictions(id) ON DELETE SET NULL,
  strategy_id    uuid        REFERENCES retention_strategies(id) ON DELETE SET NULL,
  title          text        NOT NULL,
  description    text,
  status         text        NOT NULL DEFAULT 'suggested'
                 CHECK (status IN ('suggested', 'planned', 'in_progress', 'completed', 'cancelled')),
  priority       text        NOT NULL DEFAULT 'medium'
                 CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  assigned_to    uuid        REFERENCES users(id) ON DELETE SET NULL,
  due_date       date,
  notes          text,
  -- The churn probability that justified this action when it was created.
  churn_probability_at_creation numeric(9,8)
                 CHECK (churn_probability_at_creation IS NULL
                        OR (churn_probability_at_creation >= 0 AND churn_probability_at_creation <= 1)),
  completed_at   timestamptz,
  cancelled_at   timestamptz,
  created_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retention_actions_title_length
    CHECK (char_length(title) BETWEEN 3 AND 300),
  -- Terminal states must carry their timestamp.
  CONSTRAINT retention_actions_completed_has_timestamp
    CHECK (status <> 'completed' OR completed_at IS NOT NULL),
  CONSTRAINT retention_actions_cancelled_has_timestamp
    CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL),
  -- A closed action cannot still be open.
  CONSTRAINT retention_actions_not_both_closed
    CHECK (NOT (completed_at IS NOT NULL AND cancelled_at IS NOT NULL))
);

CREATE INDEX retention_actions_customer_idx
  ON customer_retention_actions (customer_id, created_at DESC);
CREATE INDEX retention_actions_status_idx
  ON customer_retention_actions (status, created_at DESC);
CREATE INDEX retention_actions_assignee_idx
  ON customer_retention_actions (assigned_to, status) WHERE assigned_to IS NOT NULL;
CREATE INDEX retention_actions_strategy_idx ON customer_retention_actions (strategy_id);
CREATE INDEX retention_actions_due_idx ON customer_retention_actions (due_date)
  WHERE due_date IS NOT NULL AND status NOT IN ('completed', 'cancelled');
-- One open action per customer and strategy, so the same suggestion is not
-- raised twice while it is still live.
CREATE UNIQUE INDEX retention_actions_one_open_per_strategy
  ON customer_retention_actions (customer_id, strategy_id)
  WHERE strategy_id IS NOT NULL AND status NOT IN ('completed', 'cancelled');

CREATE TRIGGER retention_actions_set_updated_at
  BEFORE UPDATE ON customer_retention_actions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE customer_retention_actions IS
  'Retention work a person committed to. Progress is tracked through retention_action_events.';

CREATE TABLE retention_action_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id    uuid        NOT NULL REFERENCES customer_retention_actions(id) ON DELETE CASCADE,
  from_status  text,
  to_status    text        NOT NULL
               CHECK (to_status IN ('suggested', 'planned', 'in_progress', 'completed', 'cancelled')),
  note         text,
  changed_by   uuid        REFERENCES users(id) ON DELETE SET NULL,
  changed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX retention_action_events_action_idx
  ON retention_action_events (action_id, changed_at DESC);
CREATE INDEX retention_action_events_actor_idx ON retention_action_events (changed_by);

COMMENT ON TABLE retention_action_events IS
  'Append-only status history for a retention action, so the timeline cannot be rewritten.';
