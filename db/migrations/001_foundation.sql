-- 001_foundation.sql
-- Shared types, trigger helpers and the audit-friendly timestamp plumbing that
-- every later migration depends on.
--
-- Deliberate choices:
--   * gen_random_uuid() is core in PostgreSQL 13+, so no extension is needed.
--   * Status columns use CHECK constraints rather than enum types. Adding a
--     status is then an ordinary migration instead of a type rewrite.

-- Keep a row's updated_at honest without every caller remembering to set it.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION set_updated_at() IS
  'BEFORE UPDATE trigger that stamps updated_at with the current time.';

-- A partial unique index helper: case-insensitive email uniqueness without
-- requiring the citext extension.
CREATE OR REPLACE FUNCTION lower_unique(text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT lower($1)
$$;

COMMENT ON FUNCTION lower_unique(text) IS
  'Normalises a text value for case-insensitive uniqueness constraints.';
