-- C4 服务端重放检查点。
-- 只有按原始事件重放成功的投影可以写入。不改写事件正文、导入原件或旧工作区。

CREATE TABLE replay_checkpoints (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  stream_id text NOT NULL CHECK (stream_id ~ '^[a-z]{3}_[0-9a-f-]{36}$'),
  event_count bigint NOT NULL CHECK (event_count BETWEEN 0 AND 1000000),
  event_hash text NOT NULL CHECK (event_hash ~ '^[a-f0-9]{16}$'),
  projector_version text NOT NULL CHECK (projector_version = 'player-replay-1'),
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^[a-f0-9]{64}$'),
  snapshot jsonb,
  verified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, workspace_id, stream_id, event_count),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces (id, account_id),
  FOREIGN KEY (account_id, workspace_id, stream_id)
    REFERENCES sync_streams (account_id, workspace_id, stream_id)
);

GRANT SELECT, INSERT ON replay_checkpoints TO endless_app;

ALTER TABLE replay_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE replay_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON replay_checkpoints
  USING (account_id = current_tenant_id()) WITH CHECK (account_id = current_tenant_id());
