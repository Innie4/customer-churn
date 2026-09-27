-- 002_identity.sql
-- People, their sessions and their password resets.
--
-- Passwords are stored as scrypt hashes, never as plain text and never
-- reversibly. Sessions store only a SHA-256 hash of the bearer token, so a
-- database leak does not hand out live sessions, and a session can be revoked
-- by deleting its row.

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text        NOT NULL,
  password_hash     text        NOT NULL,
  full_name         text        NOT NULL,
  role              text        NOT NULL DEFAULT 'analyst'
                    CHECK (role IN ('admin', 'analyst', 'viewer')),
  status            text        NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'suspended', 'invited')),
  -- Bumped on password change and on forced logout, which invalidates every
  -- session issued before this value.
  session_epoch     integer     NOT NULL DEFAULT 1,
  last_login_at     timestamptz,
  failed_login_count integer    NOT NULL DEFAULT 0,
  locked_until      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_format CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  CONSTRAINT users_email_length CHECK (char_length(email) <= 320)
);

CREATE UNIQUE INDEX users_email_key ON users (lower_unique(email));
CREATE INDEX users_role_idx ON users (role) WHERE status = 'active';

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE users IS
  'Platform users. Authentication is handled by this application, not by an external identity provider.';

CREATE TABLE profiles (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  job_title     text,
  department    text,
  phone         text,
  -- Free-form preferences that only ever affect presentation.
  preferences   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE profiles IS
  'Non-credential detail about a user. Kept separate so users stays about access.';

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SHA-256 of the bearer token. The token itself is only ever in the cookie.
  token_hash   text        NOT NULL UNIQUE,
  session_epoch integer    NOT NULL,
  user_agent   text,
  ip_address   text,
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_expiry_in_future CHECK (expires_at > created_at)
);

CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

COMMENT ON TABLE sessions IS
  'Server-side session records. Only a hash of the session token is stored.';

CREATE TABLE password_reset_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text        NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  requested_ip text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reset_expiry_in_future CHECK (expires_at > created_at)
);

CREATE INDEX password_reset_user_idx ON password_reset_tokens (user_id);
CREATE INDEX password_reset_expiry_idx ON password_reset_tokens (expires_at)
  WHERE used_at IS NULL;

COMMENT ON TABLE password_reset_tokens IS
  'Single-use password reset tokens, stored hashed so an emailed link cannot be replayed from a database dump.';
