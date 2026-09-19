ALTER TABLE conversation_events
  ADD COLUMN context_event_id uuid,
  ADD COLUMN context_source_id uuid;

ALTER TABLE conversation_events
  ADD CONSTRAINT conversation_events_context_event_user_only
  CHECK (
    (context_event_id IS NULL AND context_source_id IS NULL)
    OR (
      role = 'user'
      AND context_event_id IS NOT NULL
      AND context_source_id IS NOT NULL
    )
  ) NOT VALID;
