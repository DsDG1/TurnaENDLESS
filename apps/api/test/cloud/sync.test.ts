import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { stableStringify } from '@endless/esl';
import { applyPlayerCommand, buildBackup, validateCloudBackup, type Workspace } from '@endless/content';
import { getOptions, getScenes } from '@endless/player';
import type { SyncEventEntry, SyncStreamIdSchema } from '@endless/cloud-contracts';
import type { z } from 'zod';
import { AuthService, type AuthContext } from '../../src/cloud/auth/service.js';
import { OutboxMailer, readQueuedMail } from '../../src/cloud/mail.js';
import { ObjectService } from '../../src/cloud/objects/service.js';
import { S3ObjectStorage } from '../../src/cloud/objects/storage.js';
import { ImportService } from '../../src/cloud/imports/service.js';
import { SyncService, commandOfEvent, encodeSyncCursor } from '../../src/cloud/sync/service.js';
import { createCloudServer } from '../../src/cloud/server.js';
import { cloudCapabilities } from '../../src/cloud/capabilities.js';
import { cloudFixture, closeServer, listenLoopback, TEST_MAIL_KEY, TEST_PEPPER } from './fixtures.js';
import { withClient } from './embedded-pg.js';
import { fakeObjectStorage, S3_CREDENTIALS } from './object-storage-fixture.js';
import { cloudTestContent as content, cloudTestWorkspace } from '../../../../packages/content/test/cloud-fixture.js';

type StreamId = z.infer<typeof SyncStreamIdSchema>;

let fixture: Awaited<ReturnType<typeof cloudFixture>>;
let s3: Awaited<ReturnType<typeof fakeObjectStorage>>;
let storage: S3ObjectStorage;
let objects: ObjectService;
let imports: ImportService;
let sync: SyncService;
let server: ReturnType<typeof createCloudServer>;
let base: string;
let a: AuthContext;
let b: AuthContext;
let second: AuthContext;
let cookie: string;
let cookieB: string;
const ORIGIN = 'https://endless.example.test';
const sha = (value: unknown) => createHash('sha256').update(stableStringify(value)).digest('hex');
const bytes = (workspace: Workspace) => Buffer.from(JSON.stringify(buildBackup(workspace)));

const episode = content.pilot.episodes[0]!;
const scenes = getScenes(episode);
const optionScene = scenes.find((scene) => getOptions(scene).length)!;
const correct = getOptions(optionScene).findIndex((choice) => choice.correct);
const wrong = (correct + 1) % getOptions(optionScene).length;

/**
 * 在**同一份本地工作区**上重放真实播放器命令，产生真实事件（含内容/修订盖章）。
 * 只有在这份工作区导入之后继续播放，盖章才指向云端的真实映射——
 * 每次新建工作区会产生新的内容 ID，那些事件理应被服务端拒绝。
 */
function play(start: Workspace, options: { limit: number; choice?: number; at?: (index: number) => string }) {
  const at = options.at ?? ((index: number) => new Date(Date.parse('2026-10-24T09:00:00.000Z') + index * 1000).toISOString());
  let workspace = applyPlayerCommand(content, start, { type: 'select', episode: episode.id }, new Date(at(0)));
  let tick = 1;
  const reached = () => workspace.branches[0]!.session.events.length >= options.limit;
  outer: for (const scene of getScenes(episode)) {
    if (getOptions(scene).length) {
      workspace = applyPlayerCommand(content, workspace, {
        type: 'answer', scene: scene.id, choice: options.choice ?? correct,
      }, new Date(at(tick++)));
      if (reached()) break outer;
    }
    const before = workspace.branches[0]!.session.events.length;
    workspace = applyPlayerCommand(content, workspace, { type: 'advance', scene: scene.id, skip: false }, new Date(at(tick++)));
    if (workspace.branches[0]!.session.events.length === before) throw new Error('推进没有产生事件');
    if (reached()) break outer;
  }
  return workspace;
}

/** 两台设备在共同前缀之后的第一个不同事件：这就是「离线相反选择」的分叉点。 */
function diverge(local: Workspace) {
  const left = entries(play(local, { limit: 6, choice: correct }));
  const right = entries(play(local, { limit: 6, choice: wrong }));
  const split = left.findIndex((entry, index) => stableStringify(entry.event) !== stableStringify(right[index]?.event));
  if (split < 0) throw new Error('两种选择没有产生不同事件');
  return { left, right, split };
}

function entries(workspace: Workspace, from = 0): SyncEventEntry[] {
  return workspace.branches[0]!.session.events.slice(from).map((event, index) => ({
    eventId: randomUUID(), seq: from + index + 1,
    at: event.at,
    event: event as SyncEventEntry['event'],
    command: commandOfEvent(event as { type: string; scene: string; choice?: number; skip?: boolean }),
    digest: sha(event),
  }));
}

const streamOf = (workspace: Workspace) => workspace.branches[0]!.id as StreamId;

beforeAll(async () => {
  fixture = await cloudFixture();
  s3 = await fakeObjectStorage();
  storage = new S3ObjectStorage({ endpoint: s3.endpoint, bucket: 'synthetic-bucket', region: 'test-1', ...S3_CREDENTIALS });
  objects = new ObjectService(fixture.app, storage, fixture.deployment, {
    quotaBytes: 16_777_216,
    backupValidator: (raw) => { validateCloudBackup(content, raw); },
  });
  imports = new ImportService(fixture.app, objects, content, fixture.deployment);
  sync = new SyncService(fixture.app);
  const auth = new AuthService(fixture.auth, new OutboxMailer(TEST_MAIL_KEY), TEST_PEPPER);
  const login = async (email = `${randomUUID()}@example.test`) => {
    const challenge = await auth.issueChallenge({ email, ip: randomUUID() }, 'sync-test');
    const code = /验证码是 (\d{6})/.exec((await readQueuedMail(fixture.auth, email, TEST_MAIL_KEY))[0]!.body)![1]!;
    const session = await auth.verifyChallenge({ challengeId: challenge.challengeId, email, code }, 'sync-test');
    return { ctx: (await auth.resolveSession(session.token))!, cookie: `__Host-endless_session=${session.token}`, email };
  };
  const first = await login();
  const other = await login();
  // 同一账号的第二台设备：跨设备同步不能靠「另一个账号」冒充
  await withClient(fixture.cluster.adminDsn, (q) => q.query("UPDATE auth_challenges SET created_at = now() - interval '2 minutes'"));
  const another = await login(first.email);
  a = first.ctx; cookie = first.cookie; b = other.ctx; cookieB = other.cookie; second = another.ctx;
  expect(second.accountId).toBe(a.accountId);
  expect(second.deviceId).not.toBe(a.deviceId);
  server = createCloudServer({
    auth: fixture.auth, app: fixture.app, pepper: TEST_PEPPER, mailer: new OutboxMailer(TEST_MAIL_KEY),
    origins: [ORIGIN], hosts: ['127.0.0.1'], deployment: fixture.deployment, objects, imports, sync,
    capabilities: cloudCapabilities({ objects: true, imports: true, sync: true }),
  });
  base = `http://127.0.0.1:${await listenLoopback(server)}`;
}, 120_000);

afterAll(async () => {
  if (server) await closeServer(server);
  storage?.close(); await s3?.close(); await fixture?.close();
}, 60_000);

async function request(path: string, method = 'GET', body?: unknown, session = cookie) {
  const response = await fetch(`${base}/api/cloud/v1${path}`, {
    method,
    headers: { origin: ORIGIN, cookie: session, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}

/** 导入一份本地工作区，并拿回它的云工作区与事件流绑定。 */
async function imported(workspace: Workspace, session = a) {
  const preview = await imports.preview(session, bytes(workspace), randomUUID());
  const receipt = (await imports.activate(session, {
    previewId: preview.preview.id, snapshotDigest: preview.preview.snapshotDigest, validationBinding: preview.preview.validationBinding,
  }, randomUUID())).receipt;
  return { receipt, workspaceId: receipt.workspaceId, bootstrap: await sync.bootstrap(session, receipt.workspaceId) };
}

const cursorOf = (workspaceId: string, seq = 0) => encodeSyncCursor(workspaceId, seq, 1);

describe('C3 增量同步：真实 PostgreSQL', () => {
  it('导入即持久化前缀事件身份：有事件的分支逐个可查，重复引导不变', async () => {
    const local = play(cloudTestWorkspace(), { limit: 3 });
    const { workspaceId, bootstrap } = await imported(local);
    expect(bootstrap.streams).toHaveLength(1);
    expect(bootstrap.streams[0]).toMatchObject({
      streamId: streamOf(local), branchId: streamOf(local), eventSeq: 3,
    });
    expect(bootstrap.streams[0]!.lastEventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(bootstrap.changeSeq).toBe(0);
    const again = await sync.bootstrap(a, workspaceId);
    expect(again).toEqual(bootstrap);
    // 前缀事件确实入库，且与导入副本的事件数一致
    const rows = await fixture.app.withTenant(a.accountId, (q) => q.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM stream_events WHERE account_id = $1 AND workspace_id = $2', [a.accountId, workspaceId],
    ));
    expect(rows.rows[0]!.n).toBe(3);
  });

  it('空事件的工作区也能同步：流头为 0，第一次推送即从 1 开始', async () => {
    const local = cloudTestWorkspace();
    const { workspaceId, bootstrap } = await imported(local);
    expect(bootstrap.streams[0]).toMatchObject({ eventSeq: 0, lastEventId: null });
    const played = play(local, { limit: 1 });
    const pushed = await sync.push(a, {
      workspaceId, batchId: randomUUID(), baseVersion: bootstrap.cloudVersion,
      streams: [{ streamId: streamOf(local), baseSeq: 0, baseEventId: null, events: entries(played) }],
    });
    expect(pushed.receipt).toMatchObject({ applied: 1, duplicate: 0, changeSeq: 1 });
  });

  it('能力发现跟随挂载：启用同步后 sync 为 true，未实现的仍为 false', async () => {
    expect((await request('/capabilities')).body.features).toMatchObject({
      sync: true, objects: true, import: true, generation: false, credits: false, billing: false,
    });
  });

  it('变更按序递增，游标分页前进且不重复', async () => {
    const local = cloudTestWorkspace();
    const { workspaceId, bootstrap } = await imported(local);
    const all = entries(play(local, { limit: 2 }));
    // 两个批次 → 两条变更，才能真正验证分页与 nextCursor
    const first = await sync.push(a, {
      workspaceId, batchId: randomUUID(), baseVersion: bootstrap.cloudVersion,
      streams: [{ streamId: streamOf(local), baseSeq: 0, baseEventId: null, events: [all[0]!] }],
    });
    expect(first.receipt).toMatchObject({ applied: 1, changeSeq: 1 });
    const second = await sync.push(a, {
      workspaceId, batchId: randomUUID(), baseVersion: first.receipt.cloudVersion,
      streams: [{ streamId: streamOf(local), baseSeq: 1, baseEventId: all[0]!.eventId, events: [all[1]!] }],
    });
    expect(second.receipt).toMatchObject({ applied: 1, changeSeq: 2 });
    expect(second.receipt.streams[0]).toMatchObject({ eventSeq: 2, lastEventId: all[1]!.eventId });

    const firstPage = await sync.pull(a, workspaceId, cursorOf(workspaceId), 1);
    expect(firstPage.changes.map((change) => change.seq)).toEqual([1]);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.changes[0]!.events.map((event) => event.eventId)).toEqual([all[0]!.eventId]);
    const secondPage = await sync.pull(a, workspaceId, firstPage.nextCursor, 1);
    expect(secondPage.changes.map((change) => change.seq)).toEqual([2]);
    expect(secondPage.hasMore).toBe(false);
    // 重放命令随事件一起下发：另一台设备据此还原同一事件
    expect(secondPage.changes[0]!.events[0]!.command).toEqual(all[1]!.command);
    expect((await sync.pull(a, workspaceId, secondPage.nextCursor, 10)).changes).toEqual([]);
  });

  it('同批次并发提交 20 次只生效一次，重放返回同一回执；换正文则 409', async () => {
    const local = cloudTestWorkspace();
    const { workspaceId, bootstrap } = await imported(local);
    const played = play(local, { limit: 1 });
    const all = entries(played);
    const batchId = randomUUID();
    const input = {
      workspaceId, batchId, baseVersion: bootstrap.cloudVersion,
      streams: [{ streamId: streamOf(local), baseSeq: 0, baseEventId: null, events: all }],
    };
    const results = await Promise.all(Array.from({ length: 20 }, () => sync.push(a, input)));
    expect(new Set(results.map((result) => result.receipt.changeSeq))).toEqual(new Set([1]));
    expect(results.every((result) => result.receipt.applied === 1)).toBe(true);
    const changes = await sync.pull(a, workspaceId, cursorOf(workspaceId), 10);
    expect(changes.changes).toHaveLength(1);
    expect(changes.changes[0]!.events).toHaveLength(1);
    await expect(sync.push(a, { ...input, baseVersion: '999' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
  });

  it('相同正文的不同合法事件各自身份，不按摘要去重', async () => {
    const local = cloudTestWorkspace();
    const { workspaceId, bootstrap } = await imported(local);
    const one = entries(play(local, { limit: 1 }))[0]!;
    // 同一动作、同一场景、同一时间的两次合法阅读：正文完全一致，是两条历史
    const twin = { ...one, eventId: randomUUID(), seq: 2 };
    const pushed = await sync.push(a, {
      workspaceId, batchId: randomUUID(), baseVersion: bootstrap.cloudVersion,
      streams: [{ streamId: streamOf(local), baseSeq: 0, baseEventId: null, events: [one, twin] }],
    });
    expect(pushed.receipt).toMatchObject({ applied: 2, duplicate: 0 });
    const changes = await sync.pull(a, workspaceId, cursorOf(workspaceId), 10);
    expect(changes.changes[0]!.events.map((event) => event.eventId)).toEqual([one.eventId, twin.eventId]);
    expect(new Set(changes.changes[0]!.events.map((event) => event.digest)).size).toBe(1);
  });

  it('同一 eventId 换正文返回冲突并保留原件，主链不被改写', async () => {
    const local = cloudTestWorkspace();
    const { workspaceId, bootstrap } = await imported(local);
    const one = entries(play(local, { limit: 1 }))[0]!;
    await sync.push(a, {
      workspaceId, batchId: randomUUID(), baseVersion: bootstrap.cloudVersion,
      streams: [{ streamId: streamOf(local), baseSeq: 0, baseEventId: null, events: [one] }],
    });
    const tampered = { ...one, event: { ...one.event, at: '2026-10-24T09:00:09.000Z' }, at: '2026-10-24T09:00:09.000Z' };
    tampered.digest = sha(tampered.event);
    await expect(sync.push(a, {
      workspaceId, batchId: randomUUID(), baseVersion: bootstrap.cloudVersion,
      streams: [{ streamId: streamOf(local), baseSeq: 1, baseEventId: one.eventId, events: [{ ...tampered, seq: 2 }] }],
    })).rejects.toMatchObject({ code: 'SYNC_CONFLICT' });
    const conflicts = await sync.conflicts(a, workspaceId);
    expect(conflicts.conflicts[0]).toMatchObject({ reason: 'event-body-mismatch', status: 'open' });
    const changes = await sync.pull(a, workspaceId, cursorOf(workspaceId), 10);
    expect(changes.changes.flatMap((change) => change.events).map((event) => event.digest)).toEqual([one.digest]);
  });

  it('两设备离线相反选择：后到的一批整批拒绝，两条历史不拼接', async () => {
    const local = cloudTestWorkspace();
    const { workspaceId, bootstrap } = await imported(local);
    const { left, right, split } = diverge(local);
    const prefix = left.slice(0, split);
    const baseSeq = split;
    const baseEventId = split ? left[split - 1]!.eventId : null;
    if (prefix.length) {
      await sync.push(a, {
        workspaceId, batchId: randomUUID(), baseVersion: bootstrap.cloudVersion,
        streams: [{ streamId: streamOf(local), baseSeq: 0, baseEventId: null, events: prefix }],
      });
    }
    await sync.push(a, {
      workspaceId, batchId: randomUUID(), baseVersion: bootstrap.cloudVersion,
      streams: [{ streamId: streamOf(local), baseSeq, baseEventId, events: [left[split]!] }],
    });
    await expect(sync.push(second, {
      workspaceId, batchId: randomUUID(), baseVersion: bootstrap.cloudVersion,
      streams: [{ streamId: streamOf(local), baseSeq, baseEventId, events: [right[split]!] }],
    })).rejects.toMatchObject({ code: 'SYNC_CONFLICT' });

    const held = await sync.conflicts(second, workspaceId);
    expect(held.conflicts[0]).toMatchObject({
      reason: 'stream-head-changed', status: 'open', baseSeq, cloudSeq: split + 1,
    });
    expect(held.conflicts[0]!.events[0]!.eventId).toBe(right[split]!.eventId);
    // 云端流头仍停在左侧历史；右侧事件一个都没混进主链
    expect((await sync.bootstrap(a, workspaceId)).streams[0]).toMatchObject({ eventSeq: split + 1, lastEventId: left[split]!.eventId });
    const changes = await sync.pull(a, workspaceId, cursorOf(workspaceId), 10);
    expect(changes.changes.flatMap((change) => change.events).map((event) => event.eventId))
      .toEqual([...prefix, left[split]!].map((entry) => entry.eventId));
  });

  it('显式放弃冲突只改冲突状态，不动主链也不删候选', async () => {
    const local = cloudTestWorkspace();
    const { workspaceId, bootstrap } = await imported(local);
    const { left, right, split } = diverge(local);
    const prefix = left.slice(0, split);
    const baseSeq = split;
    const baseEventId = split ? left[split - 1]!.eventId : null;
    if (prefix.length) {
      await sync.push(a, {
        workspaceId, batchId: randomUUID(), baseVersion: bootstrap.cloudVersion,
        streams: [{ streamId: streamOf(local), baseSeq: 0, baseEventId: null, events: prefix }],
      });
    }
    await sync.push(a, {
      workspaceId, batchId: randomUUID(), baseVersion: bootstrap.cloudVersion,
      streams: [{ streamId: streamOf(local), baseSeq, baseEventId, events: [left[split]!] }],
    });
    await expect(sync.push(second, {
      workspaceId, batchId: randomUUID(), baseVersion: bootstrap.cloudVersion,
      streams: [{ streamId: streamOf(local), baseSeq, baseEventId, events: [right[split]!] }],
    })).rejects.toMatchObject({ code: 'SYNC_CONFLICT' });
    const open = (await sync.conflicts(second, workspaceId)).conflicts[0]!;
    const resolved = await sync.resolve(second, workspaceId, open.id, { workspaceId, decision: 'discard' });
    expect(resolved.conflict).toMatchObject({ status: 'discarded' });
    expect(resolved.conflict.events[0]!.eventId).toBe(right[split]!.eventId);
    expect(resolved.stream).toMatchObject({ eventSeq: split + 1, lastEventId: left[split]!.eventId });
    expect((await sync.conflicts(second, workspaceId)).conflicts[0]).toMatchObject({ status: 'discarded' });
    await expect(sync.resolve(second, workspaceId, open.id, { workspaceId, decision: 'discard' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('账号锁内串行：并发推送不会先提交一个更大的序号', async () => {
    const local = cloudTestWorkspace();
    const { workspaceId, bootstrap } = await imported(local);
    const all = entries(play(local, { limit: 1 }));
    const client = new pg.Client({ connectionString: fixture.appDsn });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['endless.tenant_id', a.accountId]);
      await client.query('INSERT INTO account_control (account_id) VALUES ($1) ON CONFLICT DO NOTHING', [a.accountId]);
      await client.query('SELECT account_id FROM account_control WHERE account_id = $1 FOR UPDATE', [a.accountId]);
      let settled = false;
      const pending = sync.push(a, {
        workspaceId, batchId: randomUUID(), baseVersion: bootstrap.cloudVersion,
        streams: [{ streamId: streamOf(local), baseSeq: 0, baseEventId: null, events: all }],
      }).finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(settled).toBe(false);
      expect((await sync.pull(a, workspaceId, cursorOf(workspaceId), 10)).changes).toEqual([]);
      await client.query('COMMIT');
      const pushed = await pending;
      expect(pushed.receipt.changeSeq).toBe(1);
      expect((await sync.pull(a, workspaceId, cursorOf(workspaceId), 10)).changes.map((change) => change.seq)).toEqual([1]);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
  });

  it('游标超前、换代或损坏时明确要求重新引导', async () => {
    const local = cloudTestWorkspace();
    const { workspaceId } = await imported(local);
    await expect(sync.pull(a, workspaceId, encodeSyncCursor(workspaceId, 9, 1))).rejects.toMatchObject({ code: 'CURSOR_EXPIRED' });
    await expect(sync.pull(a, workspaceId, encodeSyncCursor(workspaceId, 0, 7))).rejects.toMatchObject({ code: 'CURSOR_EXPIRED' });
    await expect(sync.pull(a, workspaceId, 'not-a-cursor')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(sync.pull(a, workspaceId, encodeSyncCursor(randomUUID(), 0, 1))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('跨账号读写工作区一律拒绝，不泄露事件与冲突', async () => {
    const local = cloudTestWorkspace();
    const { workspaceId, bootstrap } = await imported(local);
    await expect(sync.bootstrap(b, workspaceId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(sync.pull(b, workspaceId, cursorOf(workspaceId))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(sync.conflicts(b, workspaceId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(sync.push(b, {
      workspaceId, batchId: randomUUID(), baseVersion: bootstrap.cloudVersion,
      streams: [{ streamId: bootstrap.streams[0]!.streamId, baseSeq: 0, baseEventId: null, events: [] }],
    })).rejects.toBeTruthy();
    expect((await request(`/sync/pull?workspaceId=${workspaceId}`, 'GET', undefined, cookieB)).status).toBe(404);
  });

  it('伪造内容/修订盖章的事件被拒绝，单边盖章也不接受', async () => {
    const local = cloudTestWorkspace();
    const { workspaceId, bootstrap } = await imported(local);
    const one = entries(play(local, { limit: 1 }))[0]!;
    const forged = { ...one, event: { ...one.event, contentId: 'ent_00000000-0000-0000-0000-000000000000', revisionId: 'rev_00000000-0000-0000-0000-000000000000' } };
    forged.digest = sha(forged.event);
    await expect(sync.push(a, {
      workspaceId, batchId: randomUUID(), baseVersion: bootstrap.cloudVersion,
      streams: [{ streamId: streamOf(local), baseSeq: 0, baseEventId: null, events: [forged] }],
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const half = { ...one, event: { ...one.event, contentId: 'ent_00000000-0000-0000-0000-000000000000' } };
    half.digest = sha(half.event);
    await expect(sync.push(a, {
      workspaceId, batchId: randomUUID(), baseVersion: bootstrap.cloudVersion,
      streams: [{ streamId: streamOf(local), baseSeq: 0, baseEventId: null, events: [half] }],
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('设备界面状态按设备隔离：不产生变更，也不推进工作区版本', async () => {
    const local = cloudTestWorkspace();
    const { workspaceId, bootstrap } = await imported(local);
    await sync.putDeviceStates(a, { workspaceId, states: [{ streamId: streamOf(local), currentEpisode: 'ep-1', largeText: true }] });
    expect((await sync.deviceStates(a, workspaceId)).states[0]).toMatchObject({ currentEpisode: 'ep-1', largeText: true });
    expect((await sync.deviceStates(second, workspaceId)).states).toEqual([]);
    expect((await sync.bootstrap(a, workspaceId)).cloudVersion).toBe(bootstrap.cloudVersion);
    expect((await sync.pull(a, workspaceId, cursorOf(workspaceId), 10)).changes).toEqual([]);
  });

  it('HTTP 层可用；未挂载同步时能力为 false 且路由不存在', async () => {
    const local = cloudTestWorkspace();
    const { workspaceId, bootstrap } = await imported(local);
    const all = entries(play(local, { limit: 1 }));
    const pushed = await request('/sync/push', 'POST', {
      workspaceId, batchId: randomUUID(), baseVersion: bootstrap.cloudVersion,
      streams: [{ streamId: streamOf(local), baseSeq: 0, baseEventId: null, events: all }],
    });
    expect(pushed.status).toBe(200);
    expect(pushed.body.receipt.applied).toBe(1);
    expect((await request(`/sync/pull?workspaceId=${workspaceId}`)).body.changes).toHaveLength(1);
    expect((await request(`/sync/conflicts?workspaceId=${workspaceId}`)).body.conflicts).toEqual([]);
    expect((await request(`/sync/bootstrap?workspaceId=${workspaceId}`)).body.streams).toHaveLength(1);
    expect((await request('/sync/push', 'POST', { workspaceId })).status).toBe(400);
    expect((await request(`/sync/pull?workspaceId=${workspaceId}&limit=abc`)).status).toBe(400);

    const bare = createCloudServer({
      auth: fixture.auth, app: fixture.app, pepper: TEST_PEPPER, mailer: new OutboxMailer(TEST_MAIL_KEY),
      origins: [ORIGIN], hosts: ['127.0.0.1'], deployment: fixture.deployment,
      capabilities: cloudCapabilities(),
    });
    const bareBase = `http://127.0.0.1:${await listenLoopback(bare)}`;
    try {
      const response = await fetch(`${bareBase}/api/cloud/v1/capabilities`);
      expect((await response.json() as any).features.sync).toBe(false);
      const denied = await fetch(`${bareBase}/api/cloud/v1/sync/pull?workspaceId=${workspaceId}`, { headers: { origin: ORIGIN, cookie } });
      expect(denied.status).toBe(404);
    } finally {
      await closeServer(bare);
    }
  });

  it('未知流不静默创建：本机新分支的事件保留而不落到别的分支', async () => {
    const local = cloudTestWorkspace();
    const { workspaceId, bootstrap } = await imported(local);
    const all = entries(play(local, { limit: 1 }));
    await expect(sync.push(a, {
      workspaceId, batchId: randomUUID(), baseVersion: bootstrap.cloudVersion,
      streams: [{ streamId: `brn_${randomUUID()}` as StreamId, baseSeq: 0, baseEventId: null, events: all }],
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTRACT' });
  });

  it('未激活的工作区不分配事件身份', async () => {
    const staging = await fixture.app.withTenant(a.accountId, (q) => q.query<{ id: string }>(
      `INSERT INTO workspaces (account_id, source_local_id, contract, status)
       VALUES ($1, $2, 'endless-workspace/1', 'staging') RETURNING id`,
      [a.accountId, `staging-${randomUUID()}`],
    ));
    await expect(sync.bootstrap(a, staging.rows[0]!.id)).rejects.toMatchObject({ code: 'BASIS_CHANGED' });
    expect((await fixture.app.query('SELECT count(*)::int AS n FROM sync_streams WHERE workspace_id = $1', [staging.rows[0]!.id])).rows[0]).toEqual({ n: 0 });
  });
});

describe('游标编码', () => {
  it('绑定工作区与序号，且不是可直接读的明文 JSON', () => {
    const id = randomUUID();
    const cursor = encodeSyncCursor(id, 12, 3);
    expect(cursor).not.toContain('{');
    expect(Buffer.from(cursor, 'base64url').toString('utf8')).toContain(id);
  });
});
