ALTER TABLE violet_instances
  ADD COLUMN memory_revision bigint NOT NULL DEFAULT 0 CHECK (memory_revision >= 0),
  ADD COLUMN restore_epoch bigint NOT NULL DEFAULT 0 CHECK (restore_epoch >= 0);

-- Only structural metadata is plaintext. Content, kind and sensitivity share an envelope.
CREATE TABLE memories (
  instance_id uuid NOT NULL REFERENCES violet_instances(id),
  id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  state text NOT NULL CHECK (state IN ('current', 'superseded')),
  origin text NOT NULL CHECK (origin = 'explicit'),
  envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (instance_id, id, version)
);
CREATE UNIQUE INDEX memories_current_version
  ON memories (instance_id, id) WHERE state = 'current';

CREATE TABLE memory_sources (
  instance_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  memory_version integer NOT NULL,
  event_id uuid NOT NULL REFERENCES conversation_events(id) ON DELETE CASCADE,
  start_byte integer NOT NULL CHECK (start_byte >= 0),
  end_byte integer NOT NULL CHECK (end_byte > start_byte),
  PRIMARY KEY (instance_id, memory_id, memory_version, event_id, start_byte, end_byte),
  FOREIGN KEY (instance_id, memory_id, memory_version)
    REFERENCES memories (instance_id, id, version) ON DELETE CASCADE
);

CREATE TABLE memory_summary (
  instance_id uuid PRIMARY KEY REFERENCES violet_instances(id),
  memory_revision bigint NOT NULL CHECK (memory_revision >= 0),
  envelope jsonb NOT NULL
);

-- Idempotent outcomes contain IDs only; they do not duplicate the source or memory.
CREATE TABLE memory_operations (
  instance_id uuid NOT NULL REFERENCES violet_instances(id),
  request_id uuid NOT NULL,
  source_event_id uuid NOT NULL REFERENCES conversation_events(id) ON DELETE CASCADE,
  changes jsonb NOT NULL,
  PRIMARY KEY (instance_id, request_id)
);

CREATE TABLE memory_deletions (
  instance_id uuid NOT NULL REFERENCES violet_instances(id),
  id uuid NOT NULL,
  preview jsonb NOT NULL,
  restore_epoch bigint,
  device_id text,
  status text NOT NULL DEFAULT 'preview'
    CHECK (status IN ('preview', 'pending', 'running', 'complete', 'failed')),
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  policy_version text NOT NULL DEFAULT '1d-v1',
  PRIMARY KEY (instance_id, id)
);

-- Keep only nonsemantic request identities to reject delayed writes and same-ID retries.
CREATE TABLE deletion_tombstones (
  instance_id uuid NOT NULL REFERENCES violet_instances(id),
  request_id uuid NOT NULL,
  deletion_id uuid NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id, request_id),
  FOREIGN KEY (instance_id, deletion_id) REFERENCES memory_deletions (instance_id, id)
);

-- The trigger shares the instance lock with deletion, including writers outside Core.
CREATE FUNCTION reject_deleted_conversation_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM violet_instances WHERE id = NEW.instance_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM deletion_tombstones
    WHERE instance_id = NEW.instance_id AND request_id = NEW.request_id
  ) THEN
    RAISE EXCEPTION 'Conversation request has been deleted' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER conversation_events_reject_deleted
  BEFORE INSERT ON conversation_events
  FOR EACH ROW EXECUTE FUNCTION reject_deleted_conversation_request();
