CREATE TABLE cloud_deployment (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  environment text NOT NULL CHECK (environment IN ('development', 'test', 'staging', 'production')),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON cloud_deployment TO endless_auth, endless_app;

ALTER TABLE workspaces ADD CONSTRAINT workspaces_owner_unique UNIQUE (id, account_id);
ALTER TABLE devices ADD CONSTRAINT devices_owner_unique UNIQUE (id, account_id);
ALTER TABLE workspace_memberships ADD CONSTRAINT memberships_workspace_owner_fk
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces (id, account_id);
ALTER TABLE device_bindings ADD CONSTRAINT bindings_workspace_owner_fk
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces (id, account_id);
ALTER TABLE device_bindings ADD CONSTRAINT bindings_device_owner_fk
  FOREIGN KEY (device_id, account_id) REFERENCES devices (id, account_id);
ALTER TABLE sessions ADD CONSTRAINT sessions_device_owner_fk
  FOREIGN KEY (device_id, account_id) REFERENCES devices (id, account_id);

CREATE TABLE auth_rate_limits (
  scope text NOT NULL,
  key_digest bytea NOT NULL,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  hits integer NOT NULL CHECK (hits > 0),
  PRIMARY KEY (scope, key_digest)
);
GRANT SELECT, INSERT, UPDATE ON auth_rate_limits TO endless_auth;

ALTER TABLE mail_outbox ADD COLUMN payload bytea;
ALTER TABLE mail_outbox ADD COLUMN recipient_digest bytea;
ALTER TABLE mail_outbox ADD COLUMN expires_at timestamptz;
UPDATE mail_outbox SET expires_at = created_at + interval '10 minutes';
ALTER TABLE mail_outbox ALTER COLUMN expires_at SET NOT NULL;
CREATE INDEX mail_outbox_recipient_digest ON mail_outbox (recipient_digest, created_at);
CREATE INDEX mail_outbox_pending ON mail_outbox (created_at) WHERE status = 'queued';

CREATE TABLE mail_delivery_attempts (
  mail_id uuid PRIMARY KEY REFERENCES mail_outbox (id),
  claim_token uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('sending', 'sent', 'failed', 'unknown')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error_code text
);
GRANT SELECT, INSERT, UPDATE ON mail_delivery_attempts TO endless_auth;
