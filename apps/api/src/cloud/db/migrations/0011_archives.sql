-- Authoritative mutable archive membership; original imported documents remain immutable.
CREATE TABLE workspace_archives (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  version bigint NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 9007199254740990),
  volumes jsonb NOT NULL,
  origin_volumes jsonb NOT NULL,
  PRIMARY KEY (account_id, workspace_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces (id, account_id)
);
GRANT SELECT, INSERT, UPDATE ON workspace_archives TO endless_app;
ALTER TABLE workspace_archives ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_archives FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_archives
  USING (account_id = current_tenant_id()) WITH CHECK (account_id = current_tenant_id());
CREATE FUNCTION preserve_archive_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.origin_volumes IS DISTINCT FROM OLD.origin_volumes THEN RAISE EXCEPTION 'archive origin is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER archive_origin_immutable BEFORE UPDATE ON workspace_archives FOR EACH ROW EXECUTE FUNCTION preserve_archive_origin();
