-- C3 增量同步（计划 §5.2 / §8）。
-- 事件是权威记录：eventId 稳定、正文不可变；流成员关系单独存放，
-- 使同一事件日后可以作为新分支的共同前缀被引用而不复制正文。
-- change_seq 由工作区头行在同事务内递增，保证提交顺序与序号顺序一致。

ALTER TABLE workspaces ADD COLUMN sync_epoch bigint NOT NULL DEFAULT 1 CHECK (sync_epoch >= 1);

CREATE TABLE sync_streams (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  stream_id text NOT NULL CHECK (stream_id ~ '^[a-z]{3}_[0-9a-f-]{36}$'),
  branch_id text NOT NULL CHECK (branch_id = stream_id),
  event_seq bigint NOT NULL DEFAULT 0 CHECK (event_seq BETWEEN 0 AND 1000000),
  last_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, workspace_id, stream_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces (id, account_id),
  CHECK ((event_seq = 0) = (last_event_id IS NULL))
);

CREATE TABLE event_objects (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  event_id uuid NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  body jsonb NOT NULL,
  command jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  device_id uuid,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, workspace_id, event_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces (id, account_id)
);

CREATE TABLE stream_events (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  stream_id text NOT NULL,
  event_seq bigint NOT NULL CHECK (event_seq BETWEEN 1 AND 1000000),
  event_id uuid NOT NULL,
  PRIMARY KEY (account_id, workspace_id, stream_id, event_seq),
  UNIQUE (account_id, workspace_id, stream_id, event_id),
  FOREIGN KEY (account_id, workspace_id, stream_id) REFERENCES sync_streams (account_id, workspace_id, stream_id),
  FOREIGN KEY (account_id, workspace_id, event_id) REFERENCES event_objects (account_id, workspace_id, event_id)
);

CREATE TABLE workspace_change_heads (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  change_seq bigint NOT NULL DEFAULT 0 CHECK (change_seq >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, workspace_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces (id, account_id)
);

CREATE TABLE sync_batches (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  device_id uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  receipt jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, workspace_id, batch_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces (id, account_id),
  FOREIGN KEY (device_id, account_id) REFERENCES devices (id, account_id)
);

CREATE TABLE workspace_changes (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  change_seq bigint NOT NULL CHECK (change_seq >= 1),
  batch_id uuid NOT NULL,
  device_id uuid NOT NULL,
  stream_id text NOT NULL,
  from_seq bigint NOT NULL CHECK (from_seq >= 0),
  to_seq bigint NOT NULL CHECK (to_seq >= 1),
  event_ids uuid[] NOT NULL CHECK (cardinality(event_ids) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, workspace_id, change_seq),
  FOREIGN KEY (account_id, workspace_id, batch_id) REFERENCES sync_batches (account_id, workspace_id, batch_id),
  FOREIGN KEY (account_id, workspace_id, stream_id) REFERENCES sync_streams (account_id, workspace_id, stream_id),
  CHECK (to_seq = from_seq + cardinality(event_ids))
);
CREATE INDEX workspace_changes_stream ON workspace_changes (account_id, workspace_id, stream_id, change_seq);

CREATE TABLE sync_conflicts (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  id uuid NOT NULL,
  stream_id text NOT NULL,
  device_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('stream-head-changed', 'event-body-mismatch', 'event-digest-mismatch')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'discarded')),
  base_seq bigint NOT NULL CHECK (base_seq >= 0),
  cloud_seq bigint NOT NULL CHECK (cloud_seq >= 0),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  PRIMARY KEY (account_id, workspace_id, id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces (id, account_id),
  FOREIGN KEY (device_id, account_id) REFERENCES devices (id, account_id),
  FOREIGN KEY (account_id, workspace_id, stream_id) REFERENCES sync_streams (account_id, workspace_id, stream_id),
  CHECK ((status = 'open') = (resolved_at IS NULL))
);
CREATE INDEX sync_conflicts_open ON sync_conflicts (account_id, workspace_id, created_at) WHERE status = 'open';

-- 设备级界面状态：当前集与字号只属于该设备，不参与冲突判定，也不进变更流。
CREATE TABLE device_stream_state (
  account_id uuid NOT NULL,
  device_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  stream_id text NOT NULL,
  current_episode text NOT NULL CHECK (length(current_episode) BETWEEN 1 AND 128),
  large_text boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, device_id, workspace_id, stream_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces (id, account_id),
  -- 不要求该分支已存在于 sync_streams：新分支可以只有设备级界面状态，
  -- 事件流尚未建立时不该因为「记一下看到第几集」而失败。
  FOREIGN KEY (device_id, account_id) REFERENCES devices (id, account_id)
);

GRANT SELECT, INSERT, UPDATE ON sync_streams, sync_batches, sync_conflicts, device_stream_state TO endless_app;
GRANT SELECT, INSERT ON event_objects, stream_events, workspace_changes TO endless_app;
GRANT SELECT, INSERT, UPDATE ON workspace_change_heads TO endless_app;

ALTER TABLE sync_streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_streams FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_streams
  USING (account_id = current_tenant_id()) WITH CHECK (account_id = current_tenant_id());
ALTER TABLE event_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_objects FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON event_objects
  USING (account_id = current_tenant_id()) WITH CHECK (account_id = current_tenant_id());
ALTER TABLE stream_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE stream_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stream_events
  USING (account_id = current_tenant_id()) WITH CHECK (account_id = current_tenant_id());
ALTER TABLE workspace_change_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_change_heads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_change_heads
  USING (account_id = current_tenant_id()) WITH CHECK (account_id = current_tenant_id());
ALTER TABLE sync_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_batches
  USING (account_id = current_tenant_id()) WITH CHECK (account_id = current_tenant_id());
ALTER TABLE workspace_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_changes
  USING (account_id = current_tenant_id()) WITH CHECK (account_id = current_tenant_id());
ALTER TABLE sync_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_conflicts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_conflicts
  USING (account_id = current_tenant_id()) WITH CHECK (account_id = current_tenant_id());
ALTER TABLE device_stream_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_stream_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON device_stream_state
  USING (account_id = current_tenant_id()) WITH CHECK (account_id = current_tenant_id());
