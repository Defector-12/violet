ALTER TABLE violet_instances
  ADD COLUMN automatic_memory_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN memory_settings_revision bigint NOT NULL DEFAULT 0 CHECK (memory_settings_revision >= 0),
  ADD COLUMN minimum_context_revision bigint NOT NULL DEFAULT 0 CHECK (minimum_context_revision >= 0);
UPDATE violet_instances SET minimum_context_revision = memory_revision;

ALTER TABLE memories DROP CONSTRAINT memories_origin_check;
ALTER TABLE memories ADD CONSTRAINT memories_origin_check CHECK (origin IN ('explicit', 'automatic'));
ALTER TABLE memory_operations ADD COLUMN origin text NOT NULL DEFAULT 'explicit'
  CHECK (origin IN ('explicit', 'automatic'));

CREATE TABLE memory_settings_operations (
  instance_id uuid NOT NULL REFERENCES violet_instances(id),
  request_id uuid NOT NULL,
  expected_revision bigint NOT NULL CHECK (expected_revision >= 0),
  enabled boolean NOT NULL,
  PRIMARY KEY (instance_id, request_id)
);

-- NULL marks pre-migration and disabled-period inputs. Re-enabling never backfills them.
ALTER TABLE conversation_events ADD COLUMN memory_settings_revision bigint;
CREATE FUNCTION stamp_memory_settings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT CASE WHEN NEW.role = 'user' AND automatic_memory_enabled
    THEN memory_settings_revision ELSE NULL END INTO NEW.memory_settings_revision
  FROM violet_instances WHERE id = NEW.instance_id FOR UPDATE;
  RETURN NEW;
END;
$$;
CREATE TRIGGER conversation_events_memory_settings
  BEFORE INSERT ON conversation_events
  FOR EACH ROW EXECUTE FUNCTION stamp_memory_settings();

-- Retrying a failed/cancelled turn never retroactively opts it into learning.
CREATE FUNCTION disqualify_failed_memory_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM violet_instances WHERE id = NEW.instance_id FOR UPDATE;
  UPDATE conversation_events SET memory_settings_revision = NULL
    WHERE instance_id = NEW.instance_id AND request_id = NEW.request_id AND role = 'user';
  RETURN NEW;
END;
$$;
CREATE TRIGGER conversation_failure_memory_settings
  AFTER INSERT OR UPDATE ON conversation_turn_failures
  FOR EACH ROW EXECUTE FUNCTION disqualify_failed_memory_source();

-- No semantic content: source text stays in the encrypted ledger.
CREATE TABLE memory_jobs (
  instance_id uuid NOT NULL REFERENCES violet_instances(id),
  request_id uuid NOT NULL,
  source_event_id uuid NOT NULL REFERENCES conversation_events(id) ON DELETE CASCADE,
  assistant_event_id uuid NOT NULL REFERENCES conversation_events(id) ON DELETE CASCADE,
  settings_revision bigint NOT NULL,
  deletion_revision bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'complete', 'skipped', 'failed')),
  claim_id uuid,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  failure_code text,
  PRIMARY KEY (instance_id, request_id)
);
CREATE INDEX memory_jobs_pending ON memory_jobs (available_at, created_at)
  WHERE status = 'pending';
