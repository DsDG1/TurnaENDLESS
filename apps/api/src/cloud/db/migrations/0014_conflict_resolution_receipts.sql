-- Keep and discard share one one-way adjudication. Legacy discarded rows may acquire a receipt once.
CREATE FUNCTION protect_sync_conflict_resolution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.account_id, NEW.workspace_id, NEW.id, NEW.stream_id, NEW.device_id,
         NEW.reason, NEW.base_seq, NEW.cloud_seq, NEW.payload, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.account_id, OLD.workspace_id, OLD.id, OLD.stream_id, OLD.device_id,
         OLD.reason, OLD.base_seq, OLD.cloud_seq, OLD.payload, OLD.created_at) THEN
    RAISE EXCEPTION 'sync conflict identity and candidate are immutable';
  END IF;
  IF OLD.resolution_receipt IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'sync conflict resolution receipt is immutable';
  END IF;
  IF OLD.status <> 'open' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'sync conflict resolution cannot change decision';
  END IF;
  IF OLD.resolved_at IS NOT NULL AND NEW.resolved_at IS DISTINCT FROM OLD.resolved_at THEN
    RAISE EXCEPTION 'sync conflict resolution time is immutable';
  END IF;
  IF NEW.resolution_receipt IS NOT NULL AND (NEW.status = 'open'
     OR NEW.resolution_receipt #>> '{conflict,id}' IS DISTINCT FROM NEW.id::text
     OR NEW.resolution_receipt #>> '{conflict,workspaceId}' IS DISTINCT FROM NEW.workspace_id::text
     OR NEW.resolution_receipt #>> '{conflict,status}' IS DISTINCT FROM NEW.status) THEN
    RAISE EXCEPTION 'sync conflict receipt must bind the resolved candidate';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sync_conflict_resolution_immutable BEFORE UPDATE ON sync_conflicts
  FOR EACH ROW EXECUTE FUNCTION protect_sync_conflict_resolution();
