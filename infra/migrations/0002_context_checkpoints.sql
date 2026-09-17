ALTER TABLE violet_instances
  ADD COLUMN deletion_revision bigint NOT NULL DEFAULT 0 CHECK (deletion_revision >= 0);

CREATE TABLE context_epochs (
  instance_id uuid NOT NULL REFERENCES violet_instances(id),
  id uuid NOT NULL,
  started_at timestamptz NOT NULL,
  last_user_input_at timestamptz NOT NULL,
  PRIMARY KEY (instance_id, id),
  CHECK (last_user_input_at >= started_at)
);

ALTER TABLE conversation_events
  ADD COLUMN context_epoch_id uuid;

ALTER TABLE conversation_events
  ADD CONSTRAINT conversation_events_context_epoch_fk
  FOREIGN KEY (instance_id, context_epoch_id)
  REFERENCES context_epochs (instance_id, id);

CREATE INDEX conversation_events_epoch_sequence_idx
  ON conversation_events (instance_id, context_epoch_id, sequence);

CREATE TABLE context_checkpoints (
  instance_id uuid NOT NULL,
  context_epoch_id uuid NOT NULL,
  from_sequence bigint NOT NULL CHECK (from_sequence > 0),
  through_sequence bigint NOT NULL CHECK (through_sequence >= from_sequence),
  deletion_revision bigint NOT NULL CHECK (deletion_revision >= 0),
  algorithm text NOT NULL CHECK (algorithm = 'AES-256-GCM'),
  key_version text NOT NULL,
  ciphertext bytea NOT NULL,
  content_nonce bytea NOT NULL CHECK (octet_length(content_nonce) = 12),
  content_tag bytea NOT NULL CHECK (octet_length(content_tag) = 16),
  wrapped_key bytea NOT NULL,
  key_nonce bytea NOT NULL CHECK (octet_length(key_nonce) = 12),
  key_tag bytea NOT NULL CHECK (octet_length(key_tag) = 16),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (instance_id, context_epoch_id),
  FOREIGN KEY (instance_id, context_epoch_id)
    REFERENCES context_epochs (instance_id, id)
);
