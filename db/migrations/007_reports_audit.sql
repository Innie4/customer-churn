-- 007_reports_audit.sql
-- Generated reports and the audit trail.
--
-- The audit log is append-only and deliberately has no update or delete path
-- in the application. It records who did what, never any secret or credential.

CREATE TABLE reports (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text        NOT NULL
                    CHECK (kind IN ('model_performance', 'prediction_summary',
                                    'retention_summary', 'dataset_summary',
                                    'shap_global', 'audit_trail')),
  title             text        NOT NULL,
  format            text        NOT NULL CHECK (format IN ('pdf', 'csv', 'json')),
  status            text        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'generating', 'completed', 'failed')),
  storage_path      text,
  storage_provider  text        NOT NULL DEFAULT 'local'
                    CHECK (storage_provider IN ('local', 's3')),
  size_bytes        bigint      CHECK (size_bytes IS NULL OR size_bytes >= 0),
  content_type      text,
  -- What the report was generated from. Stored so a report can be traced back
  -- to the exact model and dataset it describes.
  parameters        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  dataset_id        uuid        REFERENCES datasets(id) ON DELETE SET NULL,
  model_result_id   uuid        REFERENCES model_results(id) ON DELETE SET NULL,
  -- A small structured preview, so the reports list can show what is inside
  -- without opening the file.
  summary           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  error             text,
  error_stage       text,
  generated_by      uuid        REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  CONSTRAINT reports_title_length CHECK (char_length(title) BETWEEN 3 AND 300),
  -- A completed report must have a file behind it.
  CONSTRAINT reports_completed_has_file
    CHECK (status <> 'completed' OR storage_path IS NOT NULL),
  -- A failed report must say why.
  CONSTRAINT reports_failed_has_error CHECK (status <> 'failed' OR error IS NOT NULL)
);

CREATE INDEX reports_kind_idx ON reports (kind, created_at DESC);
CREATE INDEX reports_status_idx ON reports (status);
CREATE INDEX reports_dataset_idx ON reports (dataset_id) WHERE dataset_id IS NOT NULL;
CREATE INDEX reports_model_idx ON reports (model_result_id) WHERE model_result_id IS NOT NULL;
CREATE INDEX reports_created_idx ON reports (created_at DESC);

COMMENT ON TABLE reports IS
  'Generated reports. A completed report always has a stored file; the constraint prevents a report that claims to exist without one.';

CREATE TABLE audit_logs (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id  uuid        REFERENCES users(id) ON DELETE SET NULL,
  -- Recorded separately so the trail survives the user being deleted, and so
  -- a failed login by an unknown address is still attributable.
  actor_email    text,
  action         text        NOT NULL,
  resource_type  text,
  resource_id    text,
  -- Context about the action. Never credentials, tokens or secrets.
  metadata       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  outcome        text        NOT NULL DEFAULT 'success'
                 CHECK (outcome IN ('success', 'failure', 'denied')),
  ip_address     text,
  user_agent     text,
  request_id     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id, created_at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, created_at DESC);
CREATE INDEX audit_logs_resource_idx ON audit_logs (resource_type, resource_id)
  WHERE resource_type IS NOT NULL;

COMMENT ON TABLE audit_logs IS
  'Append-only record of consequential activity. No update or delete path exists in the application.';
COMMENT ON COLUMN audit_logs.metadata IS
  'Free-form context. Secrets, tokens and raw credentials must never be written here.';

-- The audit trail is append-only at the database level, not merely by
-- convention. This is the strongest available guarantee short of revoking
-- UPDATE and DELETE from every role that can read the table.
--
-- The one permitted UPDATE is the referential cleanup that detaches an entry
-- from a user who has been deleted, because actor_user_id is declared ON DELETE
-- SET NULL. That update must not change anything else, so the trigger compares
-- every audit column and rejects the write if any of them moved.
CREATE OR REPLACE FUNCTION audit_logs_are_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'audit_logs is append-only: DELETE is not permitted'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.action         IS DISTINCT FROM OLD.action
     OR NEW.actor_email  IS DISTINCT FROM OLD.actor_email
     OR NEW.resource_type IS DISTINCT FROM OLD.resource_type
     OR NEW.resource_id  IS DISTINCT FROM OLD.resource_id
     OR NEW.metadata      IS DISTINCT FROM OLD.metadata
     OR NEW.outcome       IS DISTINCT FROM OLD.outcome
     OR NEW.ip_address    IS DISTINCT FROM OLD.ip_address
     OR NEW.user_agent    IS DISTINCT FROM OLD.user_agent
     OR NEW.request_id    IS DISTINCT FROM OLD.request_id
     OR NEW.created_at    IS DISTINCT FROM OLD.created_at
     OR NEW.id            IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION
      'audit_logs is append-only: an audit entry''s content cannot be changed'
      USING ERRCODE = '42501';
  END IF;

  -- Only detaching the actor is allowed, so a deleted user can still be traced
  -- through the retained email.
  IF NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
     AND NEW.actor_user_id IS NOT NULL THEN
    RAISE EXCEPTION
      'audit_logs is append-only: the recorded actor cannot be reassigned'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_logs_block_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_are_append_only();

CREATE TRIGGER audit_logs_block_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_are_append_only();
