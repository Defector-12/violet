CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE violet_instances (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  id uuid NOT NULL UNIQUE,
  name text NOT NULL CHECK (name = 'Violet'),
  constitution_version text NOT NULL,
  next_event_sequence bigint NOT NULL DEFAULT 1 CHECK (next_event_sequence > 0),
  created_at timestamptz NOT NULL
);

CREATE TABLE devices (
  id uuid PRIMARY KEY,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  created_at timestamptz NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE TABLE conversation_events (
  id uuid PRIMARY KEY,
  instance_id uuid NOT NULL REFERENCES violet_instances(id),
  request_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  algorithm text NOT NULL CHECK (algorithm = 'AES-256-GCM'),
  key_version text NOT NULL,
  ciphertext bytea NOT NULL,
  content_nonce bytea NOT NULL CHECK (octet_length(content_nonce) = 12),
  content_tag bytea NOT NULL CHECK (octet_length(content_tag) = 16),
  wrapped_key bytea NOT NULL,
  key_nonce bytea NOT NULL CHECK (octet_length(key_nonce) = 12),
  key_tag bytea NOT NULL CHECK (octet_length(key_tag) = 16),
  occurred_at timestamptz NOT NULL,
  UNIQUE (instance_id, sequence),
  UNIQUE (instance_id, request_id, role)
);

CREATE INDEX conversation_events_instance_sequence_idx
  ON conversation_events (instance_id, sequence);
