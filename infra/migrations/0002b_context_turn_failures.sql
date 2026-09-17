CREATE TABLE conversation_turn_failures (
  instance_id uuid NOT NULL REFERENCES violet_instances(id),
  request_id uuid NOT NULL,
  context_epoch_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (instance_id, request_id),
  FOREIGN KEY (instance_id, context_epoch_id)
    REFERENCES context_epochs (instance_id, id)
);

CREATE INDEX conversation_turn_failures_epoch_idx
  ON conversation_turn_failures (instance_id, context_epoch_id);

INSERT INTO conversation_turn_failures (
  instance_id, request_id, context_epoch_id, occurred_at
)
SELECT
  users.instance_id,
  users.request_id,
  users.context_epoch_id,
  users.occurred_at
FROM conversation_events AS users
WHERE users.role = 'user'
  AND users.context_epoch_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM conversation_events AS assistants
    WHERE assistants.instance_id = users.instance_id
      AND assistants.request_id = users.request_id
      AND assistants.role = 'assistant'
  )
ON CONFLICT (instance_id, request_id) DO NOTHING;
