\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT pg_export_snapshot() AS snapshot, id AS instance_id, restore_epoch
  FROM violet_instances WHERE singleton = true \gset
\setenv VIOLET_BACKUP_SNAPSHOT :snapshot
SELECT json_build_object('instanceId', :'instance_id', 'restoreEpoch', :'restore_epoch'::bigint);
-- This transaction remains open until pg_dump finishes using the exported snapshot.
\! pg_dump --username violet --dbname violet --format custom --compress=0 --snapshot="$VIOLET_BACKUP_SNAPSHOT"
\if :SHELL_ERROR
  -- ON_ERROR_STOP propagates a failed shell dump as a failing psql process.
  SELECT 1 / 0;
\endif
COMMIT;
