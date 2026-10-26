-- C3：本机新建分支的云流注册（计划 §8.5）。
-- 流身份即分支 ID；分叉点之前的成员关系由服务端从父流复制，不复制事件正文。
-- 事件正文仍唯一存放在 event_objects，前缀成员关系以 (stream_id, event_seq) 引用。

ALTER TABLE sync_streams
  ADD COLUMN parent_stream_id text,
  ADD COLUMN fork_at_seq bigint CHECK (fork_at_seq BETWEEN 0 AND 1000000);

ALTER TABLE sync_streams
  -- 父流与分叉点必须成对出现：只有其一说明客户端漏了声明，不能当成根流
  ADD CONSTRAINT sync_streams_fork_pair CHECK ((parent_stream_id IS NULL) = (fork_at_seq IS NULL)),
  ADD CONSTRAINT sync_streams_fork_not_self CHECK (parent_stream_id IS NULL OR parent_stream_id <> stream_id),
  ADD CONSTRAINT sync_streams_fork_parent_fk
    FOREIGN KEY (account_id, workspace_id, parent_stream_id)
    REFERENCES sync_streams (account_id, workspace_id, stream_id);
