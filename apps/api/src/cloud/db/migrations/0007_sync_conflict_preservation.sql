ALTER TABLE sync_streams ADD COLUMN branch_manifest jsonb;
ALTER TABLE workspace_changes ADD COLUMN branch_manifest jsonb;
ALTER TABLE sync_conflicts DROP CONSTRAINT sync_conflicts_status_check;
ALTER TABLE sync_conflicts ADD CONSTRAINT sync_conflicts_status_check
  CHECK (status IN ('open', 'discarded', 'preserved'));
ALTER TABLE sync_conflicts ADD COLUMN resolution_digest text
  CHECK (resolution_digest ~ '^[a-f0-9]{64}$');
ALTER TABLE sync_conflicts ADD COLUMN resolution_receipt jsonb;
ALTER TABLE sync_conflicts ADD CONSTRAINT sync_conflicts_resolution_pair
  CHECK ((resolution_digest IS NULL) = (resolution_receipt IS NULL));
