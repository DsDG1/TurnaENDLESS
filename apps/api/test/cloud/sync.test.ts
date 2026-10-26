import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { stableStringify } from '@endless/esl';
import { applyPlayerCommand, buildBackup, validateCloudBackup, attachVolume, buildVolume, bridge, trashContent, type Workspace } from '@endless/content';
import { getOptions, getScenes } from '@endless/player';
import type { ArchiveCommand, ArchiveReceipt, SyncEventEntry, SyncStreamIdSchema } from '@endless/cloud-contracts';
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
import type { Querier } from '../../src/cloud/db/client.js';
import { recordManagement } from '../../src/cloud/sync/management-feed.js';

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
let secondCookie: string;
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
  sync = new SyncService(fixture.app, async (ctx, id) => (await imports.package(ctx, id)).workspace, content);
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
  a = first.ctx; cookie = first.cookie; b = other.ctx; cookieB = other.cookie; second = another.ctx; secondCookie = another.cookie;
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
  async function revisionPreview(local = cloudTestWorkspace(true)) {
    const { workspaceId, bootstrap } = await imported(local);
    const entry = local.entries.find((e) => e.sourceKind === 'generated')!;
    const revision = local.revisions.find((r) => r.id === entry.headRevisionId)!;
    if (revision.origin === 'bundled') throw new Error('fixture');
    const head = bootstrap.streams.find((s) => s.streamId === streamOf(local))!;
    return { local, workspaceId, entry, revision, input: {
      workspaceId, requestId: randomUUID(), streamId: streamOf(local), contentId: entry.id, baseRevisionId: revision.id,
      baseSeq: head.eventSeq, baseEventId: head.lastEventId, displayVersion: 0, lifecycleVersion: 0, archiveVersion: 0,
      draft: revision.draft.replace('@title Cloud fixture', '@title Cloud revision'),
    } };
  }

  it('权威修订预览沿用原计划时间与编译器，未读原位候选不写清单/事件/管理流', async () => {
    const { local, workspaceId, revision, input } = await revisionPreview();
    const before = await sync.bootstrap(a, workspaceId);
    const management = await sync.management.bootstrap(a, workspaceId);
    const result = await request('/sync/revisions/preview', 'POST', input);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ outcome: 'ready', adoptionAvailable: false,
      artifact: { compiler: 'cloud-revision-preview/1', mode: 'in-place',
        revision: { title: 'Cloud revision', parentRevisionId: revision.id, plannedAt: revision.plannedAt, basis: revision.basis },
        branch: { streamId: streamOf(local) } } });
    expect(result.body.artifact.revision.id).not.toBe(revision.id);
    expect(result.body.artifact.revisionDigest).toBe(sha(result.body.artifact.revision));
    const { digest, ...artifact } = result.body.artifact;
    expect(digest).toBe(sha(artifact));
    const after = await sync.bootstrap(a, workspaceId);
    expect(after).toEqual(before);
    expect(await sync.management.bootstrap(a, workspaceId)).toEqual(management);
    expect((await imports.package(a, workspaceId)).workspace.revisions).toEqual(local.revisions);
    expect((await request('/sync/revisions/adopt', 'POST', input)).status).toBe(404);
  });

  it('读过内容预览创建稳定新分支候选，只复制生成边界前历史，原分支保持不变', async () => {
    let local = cloudTestWorkspace(true);
    const entry = local.entries.find((e) => e.sourceKind === 'generated')!;
    const revision = local.revisions.find((r) => r.id === entry.headRevisionId)!;
    local = applyPlayerCommand(content, local, { type: 'select', episode: revision.episodeId });
    const episode = bridge(content, local).library.episodes.find((e) => e.id === revision.episodeId)!;
    const scene = getScenes(episode)[0]!;
    local = applyPlayerCommand(content, local, getOptions(scene).length
      ? { type: 'answer', scene: scene.id, choice: getOptions(scene).findIndex((o) => o.correct) }
      : { type: 'advance', scene: scene.id, skip: false }, new Date('2026-10-25T01:00:00.000Z'));
    const prepared = await revisionPreview(local);
    const result = await sync.management.revisionPreviews.submit(a, prepared.input);
    expect(result.outcome).toBe('ready');
    if (result.outcome !== 'ready' || revision.origin === 'bundled') throw new Error('fixture');
    expect(result.artifact).toMatchObject({ mode: 'fork', branch: {
      parentBranchId: streamOf(local), forkAtEventCount: revision.basis.eventCount, commonPrefixSeq: revision.basis.eventCount,
    } });
    expect(result.artifact.branch.streamId).not.toBe(streamOf(local));
    expect(result.artifact.branch.adopted.at(-1)!.revisionId).toBe((result.artifact.revision as any).id);
    expect((await sync.bootstrap(a, prepared.workspaceId)).streams).toHaveLength(1);
    expect(await sync.management.revisionPreviews.submit(second, prepared.input)).toEqual(result);
  });

  it('20 次并发预览复用同一候选身份；同请求换正文为 409，已存回执无需读取原件', async () => {
    const { input, workspaceId } = await revisionPreview();
    const results = await Promise.all(Array.from({ length: 20 }, () => sync.management.revisionPreviews.submit(a, input)));
    expect(results[0]!.outcome).toBe('ready');
    expect(new Set(results.map(stableStringify)).size).toBe(1);
    await expect(sync.management.revisionPreviews.submit(a, { ...input, draft: input.draft + '\n' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
    const offline = new SyncService(fixture.app, async () => { throw new Error('synthetic source outage'); }, content);
    expect(await offline.management.revisionPreviews.submit(a, input)).toEqual(results[0]);
    const rows = await fixture.app.withTenant(a.accountId, (q) => q.query('SELECT * FROM revision_previews WHERE workspace_id = $1', [workspaceId]));
    expect(rows.rows).toHaveLength(1);
    await expect(fixture.app.withTenant(a.accountId, (q) => q.query("UPDATE revision_previews SET receipt = '{}' WHERE workspace_id = $1", [workspaceId]))).rejects.toThrow(/immutable/);
    expect((await sync.bootstrap(a, workspaceId)).streams).toHaveLength(1);
  });

  it('原件暂不可读或裁决落库中断，保留已预留身份并在显式重试恢复', async () => {
    const { input, workspaceId } = await revisionPreview();
    const offline = new SyncService(fixture.app, async () => { throw new Error('synthetic source outage'); }, content);
    await expect(offline.management.revisionPreviews.submit(a, input)).rejects.toThrow('synthetic source outage');
    const read = () => fixture.app.withTenant(a.accountId, async (q) => (await q.query('SELECT * FROM revision_previews WHERE account_id = $1 AND request_id = $2', [a.accountId, input.requestId])).rows[0]!);
    const reserved = await read();
    expect(reserved.receipt).toBeNull();
    await withClient(fixture.cluster.adminDsn, async (q) => {
      await q.query(`CREATE FUNCTION test_preview_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic preview write failure'; END $$`);
      await q.query('CREATE TRIGGER test_preview_failure BEFORE UPDATE ON revision_previews FOR EACH ROW EXECUTE FUNCTION test_preview_failure()');
    });
    try { await expect(sync.management.revisionPreviews.submit(a, input)).rejects.toThrow('synthetic preview write failure'); }
    finally { await withClient(fixture.cluster.adminDsn, async (q) => {
      await q.query('DROP TRIGGER test_preview_failure ON revision_previews'); await q.query('DROP FUNCTION test_preview_failure()');
    }); }
    expect(await read()).toEqual(reserved);
    const restored = await sync.management.revisionPreviews.submit(a, input);
    expect(restored).toMatchObject({ outcome: 'ready', artifact: { revision: { id: reserved.revision_id, authoredAt: reserved.authored_at.toISOString() } } });
    expect((await sync.bootstrap(a, workspaceId)).streams).toHaveLength(1);
  });

  it('展示/生命周期/流头前置版本变化需新预览，既有成功不升级成当前批准', async () => {
    const { input, workspaceId } = await revisionPreview();
    const accepted = await sync.management.revisionPreviews.submit(a, input);
    await sync.metadata.submit(second, { workspaceId, commandId: randomUUID(), type: 'set-display', contentId: input.contentId,
      baseVersion: 0, value: { title: 'another title', tags: [], note: '' } });
    const stale = await sync.management.revisionPreviews.submit(a, { ...input, requestId: randomUUID() });
    expect(stale).toMatchObject({ outcome: 'conflict', reason: 'precondition', adoptionAvailable: false });
    expect(await sync.management.revisionPreviews.submit(a, input)).toEqual(accepted);
    expect(await sync.management.revisionPreviews.submit(a, { ...input, requestId: randomUUID(), displayVersion: 1, baseRevisionId: `rev_${randomUUID()}` }))
      .toMatchObject({ outcome: 'conflict' });
    await sync.management.submit(a, { workspaceId, commandId: randomUUID(), type: 'trash', contentId: input.contentId, baseVersion: 0 });
    expect(await sync.management.revisionPreviews.submit(a, { ...input, requestId: randomUUID(), displayVersion: 1 }))
      .toMatchObject({ outcome: 'conflict' });
    expect(await sync.management.revisionPreviews.submit(a, { ...input, requestId: randomUUID(), displayVersion: 1, lifecycleVersion: 1 }))
      .toMatchObject({ outcome: 'rejected', reason: 'members' });
  });

  it('读取原件期间另一设备追加真实阅读，原预览请求被持久裁决为冲突而不采用旧前缀', async () => {
    const { input, local, workspaceId, revision } = await revisionPreview();
    let release!: () => void, started!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const loading = new Promise<void>((resolve) => { started = resolve; });
    const delayed = new SyncService(fixture.app, async (ctx, id) => {
      started(); await wait; return (await imports.package(ctx, id)).workspace;
    }, content);
    const pending = delayed.management.revisionPreviews.submit(a, input);
    await loading;
    try {
      let played = applyPlayerCommand(content, local, { type: 'select', episode: revision.episodeId });
      const scene = getScenes(bridge(content, played).library.episodes.find((e) => e.id === revision.episodeId)!)[0]!;
      played = applyPlayerCommand(content, played, getOptions(scene).length
        ? { type: 'answer', scene: scene.id, choice: getOptions(scene).findIndex((o) => o.correct) }
        : { type: 'advance', scene: scene.id, skip: false }, new Date('2026-10-25T01:00:00.000Z'));
      const next = entries(played, input.baseSeq);
      expect(next).toHaveLength(1);
      await sync.push(second, { workspaceId, batchId: randomUUID(), baseVersion: '0', streams: [{
        streamId: input.streamId, baseSeq: input.baseSeq, baseEventId: input.baseEventId, events: next,
      }] });
    } finally { release(); }
    expect(await pending).toMatchObject({ outcome: 'conflict', reason: 'precondition' });
    expect((await sync.bootstrap(a, workspaceId)).streams[0]!.eventSeq).toBe(input.baseSeq + 1);
    expect(await sync.management.revisionPreviews.submit(a, input)).toMatchObject({ outcome: 'conflict' });
  });

  it('错误草稿仅返回安全错误分类；客户端不能伪造 batch/依据/时间/候选 ID，跨租户和 BYOK 受保护', async () => {
    const { input, workspaceId } = await revisionPreview();
    const invalid = { ...input, requestId: randomUUID(), draft: 'ENDLESS-DRAFT/1\n@title synthetic-invalid-body-never-echoed' };
    const rejected = await request('/sync/revisions/preview', 'POST', invalid);
    expect(rejected.body).toEqual({ workspaceId, requestId: invalid.requestId, adoptionAvailable: false, outcome: 'rejected', reason: 'content' });
    for (const extra of [{ batch: {} }, { basis: {} }, { authoredAt: '2026-10-20T00:00:00Z' }, { revisionId: `rev_${randomUUID()}` }]) {
      expect((await request('/sync/revisions/preview', 'POST', { ...input, ...extra })).status).toBe(400);
    }
    expect((await request('/sync/revisions/preview', 'POST', input, cookieB)).status).toBe(404);
    expect((await fixture.app.withTenant(b.accountId, (q) => q.query('SELECT 1 FROM revision_previews WHERE workspace_id = $1', [workspaceId]))).rowCount).toBe(0);
    const byok = await fetch(`${base}/api/cloud/v1/sync/revisions/preview`, { method: 'POST',
      headers: { origin: ORIGIN, cookie, 'content-type': 'application/json', 'x-endless-provider-key': 'synthetic-only' }, body: JSON.stringify(input) });
    expect(byok.status).toBe(403);
  });

  it('数据库事件摘要/修订盖章或生成依据伪造时拒绝编译，不写事件、不截断', async () => {
    const { input, workspaceId } = await revisionPreview();
    const original = await sync.bootstrap(a, workspaceId);
    await withClient(fixture.cluster.adminDsn, (q) => q.query(`UPDATE event_objects SET body = jsonb_set(body, '{revisionId}', to_jsonb($2::text)) WHERE workspace_id = $1`, [workspaceId, `rev_${randomUUID()}`]));
    const result = await sync.management.revisionPreviews.submit(a, input);
    expect(result).toMatchObject({ outcome: 'rejected', reason: 'history' });
    expect(await sync.bootstrap(a, workspaceId)).toEqual(original);
    const other = await revisionPreview();
    // source loader here is a synthetic fault injection, never a way for a client to submit a claimed basis.
    const tampered = new SyncService(fixture.app, async (ctx, id) => {
      const source = (await imports.package(ctx, id)).workspace;
      return { ...source, revisions: source.revisions.map((r) => r.origin === 'bundled' ? r : { ...r, basis: { ...r.basis, eventHash: '0'.repeat(16) } }) };
    }, content);
    expect(await tampered.management.revisionPreviews.submit(a, other.input)).toMatchObject({ outcome: 'rejected', reason: 'history' });
  });

  it('超过重放或预览容量拒绝并保留原记录，不以生成次数或删历史换成功', async () => {
    const { input, workspaceId } = await revisionPreview();
    await withClient(fixture.cluster.adminDsn, (q) => q.query('UPDATE sync_streams SET event_seq = 10001 WHERE workspace_id = $1', [workspaceId]));
    const overflow = await sync.management.revisionPreviews.submit(a, { ...input, requestId: randomUUID(), baseSeq: 10_000 });
    expect(overflow.outcome).toBe('conflict');
    // A second over-limit stream is not the target precondition: inventory still must reject instead of truncate it.
    await withClient(fixture.cluster.adminDsn, (q) => q.query('UPDATE sync_streams SET event_seq = $2 WHERE workspace_id = $1', [workspaceId, input.baseSeq]));
    await fixture.app.withTenant(a.accountId, (q) => q.query(`INSERT INTO sync_streams
      (account_id, workspace_id, stream_id, branch_id, event_seq, last_event_id, branch_manifest)
      SELECT account_id, workspace_id, $3, $3, 10001, last_event_id, branch_manifest FROM sync_streams WHERE workspace_id = $2 AND account_id = $1`, [a.accountId, workspaceId, `brn_${randomUUID()}`]));
    expect(await sync.management.revisionPreviews.submit(a, input)).toMatchObject({ outcome: 'rejected', reason: 'capacity' });
    const another = await revisionPreview();
    const seed = await sync.management.revisionPreviews.submit(a, another.input);
    expect(seed.outcome).toBe('ready');
    await fixture.app.withTenant(a.accountId, (q) => q.query(`INSERT INTO revision_previews
      (account_id, workspace_id, request_id, device_id, request_digest, request, revision_id, branch_id, authored_at, receipt)
      SELECT account_id, workspace_id, gen_random_uuid(), device_id, request_digest, request,
        'rev_' || gen_random_uuid(), 'brn_' || gen_random_uuid(), authored_at, receipt FROM revision_previews
      CROSS JOIN generate_series(1,63) WHERE request_id = $1`, [another.input.requestId]));
    await expect(sync.management.revisionPreviews.submit(a, { ...another.input, requestId: randomUUID() })).rejects.toMatchObject({ code: 'STORAGE_QUOTA' });
    expect(await sync.management.revisionPreviews.submit(a, another.input)).toEqual(seed);
  });

  it('展示信息独立于学习事件：同账号第二设备读取标题、标签、备注，导入原件和修订不变', async () => {
    const local = cloudTestWorkspace();
    const { workspaceId } = await imported(local);
    const contentId = local.entries[0]!.id;
    const initial = await request(`/sync/metadata?workspaceId=${workspaceId}`);
    expect(initial.status).toBe(200);
    expect(initial.body.entries.find((e: any) => e.contentId === contentId).version).toBe(0);
    const command = { workspaceId, commandId: randomUUID(), type: 'set-display', contentId, baseVersion: 0,
      value: { title: '两台设备的标题', tags: ['reading'], note: '个人备注' } };
    const accepted = await request('/sync/metadata', 'POST', command);
    expect(accepted.body).toMatchObject({ outcome: 'applied', commandId: command.commandId, entry: { version: 1, value: command.value } });
    const remote = await request(`/sync/metadata?workspaceId=${workspaceId}`, 'GET', undefined, secondCookie);
    expect(remote.body.entries.find((e: any) => e.contentId === contentId)).toEqual(accepted.body.entry);
    expect((await sync.bootstrap(a, workspaceId)).changeSeq).toBe(0);
    const original = await imports.package(a, workspaceId);
    expect(original.workspace.entries[0]!.display).toEqual(local.entries[0]!.display);
    expect(original.workspace.revisions).toEqual(local.revisions);
  });

  it('两设备并发改名只有一个版本成功；失败候选和裁决持久化，不按客户端时间覆盖', async () => {
    const local = cloudTestWorkspace();
    const { workspaceId } = await imported(local);
    const command = { workspaceId, commandId: randomUUID(), type: 'set-display' as const, contentId: local.entries[0]!.id,
      baseVersion: 0, value: { title: '设备一', tags: [], note: '' } };
    const results = await Promise.all([
      sync.metadata.submit(a, command),
      sync.metadata.submit(second, { ...command, commandId: randomUUID(), value: { ...command.value, title: '设备二' } }),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['applied', 'conflict']);
    expect(results[0]!.entry).toEqual(results[1]!.entry);
    const rows = await fixture.app.withTenant(a.accountId, (q) => q.query(
      'SELECT request, receipt FROM metadata_commands WHERE workspace_id = $1', [workspaceId]));
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.map((r) => r.request.value.title).sort()).toEqual(['设备一', '设备二']);
  });

  it('丢响应后同命令并发重试二十次只生效一次，同 ID 不同正文返回 409', async () => {
    const local = cloudTestWorkspace();
    const { workspaceId } = await imported(local);
    const command = { workspaceId, commandId: randomUUID(), type: 'set-display' as const, contentId: local.entries[0]!.id,
      baseVersion: 0, value: { title: '只改一次', tags: [], note: '' } };
    const results = await Promise.all(Array.from({ length: 20 }, () => sync.metadata.submit(a, command)));
    for (const result of results) expect(result).toEqual(results[0]);
    const changed = await request('/sync/metadata', 'POST', { ...command, value: { ...command.value, title: '不同请求' } });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('IDEMPOTENCY_MISMATCH');
    const another = await imported(cloudTestWorkspace());
    await expect(sync.metadata.submit(a, { ...command, workspaceId: another.workspaceId })).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
    expect((await sync.metadata.snapshot(a, workspaceId)).entries.find((e) => e.contentId === command.contentId)!.version).toBe(1);
  });

  it('旧冲突命令重试返回原裁决；显式新命令仍要检查最新版本', async () => {
    const local = cloudTestWorkspace();
    const { workspaceId } = await imported(local);
    const command = { workspaceId, commandId: randomUUID(), type: 'set-display' as const, contentId: local.entries[0]!.id,
      baseVersion: 0, value: { title: '第一版', tags: [], note: '' } };
    await sync.metadata.submit(a, command);
    const rejected = { ...command, commandId: randomUUID(), value: { ...command.value, title: '离线候选' } };
    const conflict = await sync.metadata.submit(second, rejected);
    expect(conflict.outcome).toBe('conflict');
    await sync.metadata.submit(a, { ...command, commandId: randomUUID(), baseVersion: 1, value: { ...command.value, title: '第二版' } });
    expect(await sync.metadata.submit(second, rejected)).toEqual(conflict);
    expect((await sync.metadata.submit(second, { ...rejected, commandId: randomUUID(), baseVersion: 1 })).outcome).toBe('conflict');
    expect((await sync.metadata.submit(second, { ...rejected, commandId: randomUUID(), baseVersion: 2 })).entry.version).toBe(3);
  });

  it('展示信息路由保持会话、Origin、BYOK、严格字段和跨租户隔离', async () => {
    const local = cloudTestWorkspace();
    const { workspaceId } = await imported(local);
    const command = { workspaceId, commandId: randomUUID(), type: 'set-display', contentId: local.entries[0]!.id,
      baseVersion: 0, value: { title: '隔离', tags: [], note: '' } };
    expect((await request(`/sync/metadata?workspaceId=${workspaceId}`, 'GET', undefined, cookieB)).status).toBe(404);
    expect((await request('/sync/metadata', 'POST', command, cookieB)).status).toBe(404);
    expect((await request('/sync/metadata', 'POST', { ...command, at: '2099-01-01T00:00:00.000Z' })).status).toBe(400);
    expect((await request('/sync/metadata', 'POST', { ...command, value: { ...command.value, subtitle: '不支持' } })).status).toBe(400);
    const noOrigin = await fetch(`${base}/api/cloud/v1/sync/metadata`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(command),
    });
    expect(noOrigin.status).toBe(403);
    const key = await fetch(`${base}/api/cloud/v1/sync/metadata?workspaceId=${workspaceId}`, {
      headers: { cookie, 'x-endless-provider-key': 'synthetic-key' },
    });
    expect(key.status).toBe(403);
    expect((await request(`/sync/metadata?workspaceId=${workspaceId}`, 'GET', undefined, '')).status).toBe(401);
    const leaked = await fixture.app.withTenant(b.accountId, (q) => q.query('SELECT * FROM content_metadata WHERE workspace_id = $1', [workspaceId]));
    expect(leaked.rows).toEqual([]);
  });

  it('旧导入只从已验证原件初始化元数据；缺少原件时拒绝而不猜客户端基线', async () => {
    const local = cloudTestWorkspace();
    const { workspaceId } = await imported(local);
    await withClient(fixture.cluster.adminDsn, async (q) => {
      await q.query('DELETE FROM content_lifecycle WHERE workspace_id = $1', [workspaceId]);
      await q.query('DELETE FROM content_metadata WHERE workspace_id = $1', [workspaceId]);
    });
    await expect(new SyncService(fixture.app).metadata.snapshot(a, workspaceId)).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTRACT' });
    const compatible = new SyncService(fixture.app, async (ctx, id) => (await imports.package(ctx, id)).workspace);
    const snapshot = await compatible.metadata.snapshot(a, workspaceId);
    expect(snapshot.entries.find((e) => e.contentId === local.entries[0]!.id)).toMatchObject({ version: 0, value: {
      title: local.entries[0]!.display.title, tags: [], note: '',
    } });
  });

  it('命令回执写入失败时真实 PG 回滚标题和版本；原命令可恢复', async () => {
    const local = cloudTestWorkspace();
    const { workspaceId } = await imported(local);
    const command = { workspaceId, commandId: randomUUID(), type: 'set-display' as const, contentId: local.entries[0]!.id,
      baseVersion: 0, value: { title: '事务故障', tags: [], note: '' } };
    await withClient(fixture.cluster.adminDsn, (q) => q.query(`
      CREATE FUNCTION fail_metadata_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic receipt write failure'; END $$;
      CREATE TRIGGER synthetic_metadata_failure BEFORE INSERT ON metadata_commands
      FOR EACH ROW EXECUTE FUNCTION fail_metadata_receipt();
    `));
    try { await expect(sync.metadata.submit(a, command)).rejects.toThrow('synthetic'); }
    finally {
      await withClient(fixture.cluster.adminDsn, (q) => q.query('DROP TRIGGER synthetic_metadata_failure ON metadata_commands; DROP FUNCTION fail_metadata_receipt()'));
    }
    expect((await sync.metadata.snapshot(a, workspaceId)).entries.find((e) => e.contentId === command.contentId)!.version).toBe(0);
    const receipts = await fixture.app.withTenant(a.accountId, (q) => q.query('SELECT * FROM metadata_commands WHERE command_id = $1', [command.commandId]));
    expect(receipts.rows).toEqual([]);
    expect((await sync.metadata.submit(a, command)).entry.version).toBe(1);
  });

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
    const installedLater = await sync.bootstrap(a, workspaceId);
    expect(installedLater.origin?.streams[0]).toMatchObject({ eventSeq: 0, lastEventId: null });
    expect(installedLater.origin?.cursor).toBe(cursorOf(workspaceId));
    expect(installedLater.streams[0]).toMatchObject({ eventSeq: 2, lastEventId: all[1]!.eventId });

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
    await expect(sync.resolve(a, workspaceId, conflicts.conflicts[0]!.id, {
      workspaceId, decision: 'keep-branch', streamId: `brn_${randomUUID()}`, baseEventId: one.eventId,
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
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

  it('保留冲突创建独立根流，共同前缀只复制成员关系，重试不重复创建', async () => {
    const local = cloudTestWorkspace();
    const { workspaceId, bootstrap } = await imported(local);
    const { left, right, split } = diverge(local);
    if (split) await sync.push(a, {
      workspaceId, batchId: randomUUID(), baseVersion: bootstrap.cloudVersion,
      streams: [{ streamId: streamOf(local), baseSeq: 0, baseEventId: null, events: left.slice(0, split) }],
    });
    const baseEventId = split ? left[split - 1]!.eventId : null;
    await sync.push(a, {
      workspaceId, batchId: randomUUID(), baseVersion: bootstrap.cloudVersion,
      streams: [{ streamId: streamOf(local), baseSeq: split, baseEventId, events: left.slice(split) }],
    });
    const rejected = {
      workspaceId, batchId: randomUUID(), baseVersion: bootstrap.cloudVersion,
      streams: [{ streamId: streamOf(local), baseSeq: split, baseEventId, events: right.slice(split) }],
    };
    await expect(sync.push(second, rejected)).rejects.toMatchObject({ code: 'SYNC_CONFLICT' });
    const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => sync.push(second, rejected)));
    expect(attempts.every((attempt) => attempt.status === 'rejected' && attempt.reason.code === 'SYNC_CONFLICT')).toBe(true);
    expect((await sync.conflicts(second, workspaceId)).conflicts).toHaveLength(1);
    await expect(sync.push(second, { ...rejected, baseVersion: '999' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
    const conflict = (await sync.conflicts(second, workspaceId)).conflicts[0]!;
    const input = { workspaceId, decision: 'keep-branch' as const, streamId: `brn_${randomUUID()}`, baseEventId };
    const first = await request(`/sync/conflicts/${conflict.id}/resolve`, 'POST', input,
      `__Host-endless_session=unused`);
    expect(first.status).toBe(401);
    await expect(sync.resolve(second, workspaceId, conflict.id, { ...input, baseEventId: randomUUID() }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const tx = fixture.app.withTenant.bind(fixture.app);
    const failure = vi.spyOn(fixture.app, 'withTenant').mockImplementation((account, fn) => tx(account, (q) => fn({
      query: ((text, params) => {
        if (text.includes("SET status = 'preserved'")) throw new Error('synthetic resolution commit failure');
        return q.query(text, params);
      }) as Querier['query'],
    })));
    try {
      await expect(sync.resolve(second, workspaceId, conflict.id, input)).rejects.toThrow('synthetic resolution commit failure');
    } finally {
      failure.mockRestore();
    }
    expect((await sync.bootstrap(a, workspaceId)).streams.map((entry) => entry.streamId)).toEqual([streamOf(local)]);
    expect((await sync.conflicts(second, workspaceId)).conflicts[0]!.status).toBe('open');
    const results = await Promise.all(Array.from({ length: 5 }, () => sync.resolve(second, workspaceId, conflict.id, input)));
    expect(results.every((result) => stableStringify(result) === stableStringify(results[0]))).toBe(true);
    const kept = results[0] as any;
    expect(kept.conflict.status).toBe('preserved');
    expect(kept.preserved.streamId).toBe(input.streamId);
    const repeated = await request(`/sync/conflicts/${conflict.id}/resolve`, 'POST', input, secondCookie);
    expect(repeated.status).toBe(200);
    expect(repeated.body).toEqual(kept);
    expect(await sync.resolve(a, workspaceId, conflict.id, input)).toEqual(kept);
    expect(kept.history.events.map((entry: SyncEventEntry) => entry.eventId)).toEqual(left.map((entry) => entry.eventId));
    const changes = await sync.pull(a, workspaceId, cursorOf(workspaceId), 100);
    const fork = changes.changes.find((change) => change.streamId === input.streamId)!;
    expect((fork as any).branch).toMatchObject({ parentBranchId: null, forkAtEventCount: null, commonStreamId: streamOf(local), commonPrefixSeq: split });
    expect(fork.events.map((entry) => entry.eventId)).toEqual(right.slice(split).map((entry) => entry.eventId));
    await fixture.app.withTenant(a.accountId, async (q) => {
      expect((await q.query('SELECT * FROM event_objects WHERE workspace_id = $1', [workspaceId])).rows).toHaveLength(left.length + right.length - split);
    });
    await expect(sync.resolve(second, workspaceId, conflict.id, { ...input, streamId: `brn_${randomUUID()}` }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
    await expect(sync.resolve(b, workspaceId, conflict.id, input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('游标超前、换代或损坏时明确要求重新引导', async () => {
    const local = cloudTestWorkspace();
    const { workspaceId } = await imported(local);
    await expect(sync.pull(a, workspaceId, encodeSyncCursor(workspaceId, 9, 1))).rejects.toMatchObject({ code: 'CURSOR_EXPIRED' });
    await expect(sync.pull(a, workspaceId, encodeSyncCursor(workspaceId, 0, 7))).rejects.toMatchObject({ code: 'CURSOR_EXPIRED' });
    await expect(sync.pull(a, workspaceId, 'not-a-cursor')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(sync.pull(a, workspaceId, encodeSyncCursor(randomUUID(), 0, 1))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('前缀冲突掩盖的坏摘要不能通过保留分支入库，整笔创建回滚', async () => {
    const local = cloudTestWorkspace();
    const { workspaceId, bootstrap } = await imported(local);
    const first = entries(play(local, { limit: 1 }));
    await sync.push(a, {
      workspaceId, batchId: randomUUID(), baseVersion: bootstrap.cloudVersion,
      streams: [{ streamId: streamOf(local), baseSeq: 0, baseEventId: null, events: first }],
    });
    const candidate = entries(play(local, { limit: 1 })).map((entry) => ({ ...entry, digest: '0'.repeat(64) }));
    await expect(sync.push(second, {
      workspaceId, batchId: randomUUID(), baseVersion: bootstrap.cloudVersion,
      streams: [{ streamId: streamOf(local), baseSeq: 0, baseEventId: null, events: candidate }],
    })).rejects.toMatchObject({ code: 'SYNC_CONFLICT' });
    const conflict = (await sync.conflicts(second, workspaceId)).conflicts[0]!;
    const before = await sync.bootstrap(second, workspaceId);
    await expect(sync.resolve(second, workspaceId, conflict.id, {
      workspaceId, decision: 'keep-branch', streamId: `brn_${randomUUID()}`, baseEventId: null,
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await sync.bootstrap(second, workspaceId)).toEqual(before);
    expect((await sync.conflicts(second, workspaceId)).conflicts[0]!.status).toBe('open');
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
      expect((await fetch(`${bareBase}/api/cloud/v1/sync/metadata?workspaceId=${workspaceId}`, { headers: { origin: ORIGIN, cookie } })).status).toBe(404);
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

describe('C3 增量管理命令：真实 PostgreSQL', () => {
  it('共同管理流包含展示与回收/恢复；分页无遗漏，重试与冲突不重复入流', async () => {
    const local = cloudTestWorkspace(true), { workspaceId } = await imported(local);
    const contentId = local.entries.find((e) => e.sourceKind === 'generated')!.id;
    const boot = await sync.management.bootstrap(a, workspaceId);
    expect(boot.changeSeq).toBe(0);
    await sync.metadata.submit(a, { workspaceId, commandId: randomUUID(), type: 'set-display', contentId,
      baseVersion: 0, value: { title: '流内标题', tags: [], note: '' } });
    const command = { workspaceId, commandId: randomUUID(), type: 'trash' as const, contentId, baseVersion: 0 };
    const accepted = await sync.management.submit(a, command);
    expect(accepted).toMatchObject({ outcome: 'applied', entry: { version: 1, value: { lifecycle: 'trashed', archiveVolumeId: null } } });
    expect(await sync.management.submit(second, command)).toEqual(accepted);
    expect((await sync.management.submit(second, { ...command, commandId: randomUUID() })).outcome).toBe('conflict');
    await sync.management.submit(second, { ...command, commandId: randomUUID(), type: 'restore', baseVersion: 1 });
    let cursor = boot.cursor;
    const types: string[] = [];
    for (let seq = 1; seq <= 3; seq++) {
      const page = await sync.management.pull(a, workspaceId, cursor, 1);
      expect(page.fromCursor).toBe(cursor); expect(page.changes[0]!.seq).toBe(seq);
      types.push(page.changes[0]!.type); cursor = page.nextCursor;
      expect(page.hasMore).toBe(seq < 3);
    }
    expect(types).toEqual(['display', 'lifecycle', 'lifecycle']);
    expect((await sync.management.pull(second, workspaceId, cursor)).changes).toEqual([]);
    expect((await sync.bootstrap(a, workspaceId)).changeSeq).toBe(0);
    const original = (await imports.package(a, workspaceId)).workspace;
    expect(original.obligations).toEqual(local.obligations); expect(original.revisions).toEqual(local.revisions);
  });

  it('两设备并发回收/恢复只有一个版本成功；命令 ID 不能跨类型复用', async () => {
    const local = cloudTestWorkspace(true), { workspaceId } = await imported(local);
    const contentId = local.entries.find((e) => e.sourceKind === 'generated')!.id;
    const command = { workspaceId, commandId: randomUUID(), type: 'trash' as const, contentId, baseVersion: 0 };
    const result = await Promise.all([sync.management.submit(a, command),
      sync.management.submit(second, { ...command, commandId: randomUUID(), type: 'restore' })]);
    expect(result.map((r) => r.outcome).sort()).toEqual(['applied', 'conflict']);
    expect(result[0]!.entry).toEqual(result[1]!.entry);
    expect((await sync.management.bootstrap(a, workspaceId)).changeSeq).toBe(1);
    await expect(sync.metadata.submit(a, { workspaceId, commandId: command.commandId, type: 'set-display', contentId,
      baseVersion: 0, value: { title: '不同类型', tags: [], note: '' } })).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
  });

  it('回收与另一设备离线追加互不丢失，原事件正文与内容引用保留', async () => {
    const local = cloudTestWorkspace(true), { workspaceId, bootstrap } = await imported(local);
    const contentId = local.entries.find((e) => e.sourceKind === 'generated')!.id;
    const episode = bridge(content, local).library.episodes.at(-1)!;
    const selected = applyPlayerCommand(content, local, { type: 'select', episode: episode.id });
    const advanced = applyPlayerCommand(content, selected, { type: 'advance', scene: getScenes(episode)[0]!.id, skip: false }, new Date('2026-10-26T09:00:00.000Z'));
    const count = local.branches[0]!.session.events.length;
    expect(advanced.branches[0]!.session.events.length).toBe(count + 1);
    await Promise.all([
      sync.management.submit(a, { workspaceId, commandId: randomUUID(), type: 'trash', contentId, baseVersion: 0 }),
      sync.push(second, { workspaceId, batchId: randomUUID(), baseVersion: bootstrap.cloudVersion, streams: [{
        streamId: streamOf(local), baseSeq: count, baseEventId: bootstrap.streams[0]!.lastEventId, events: entries(advanced, count),
      }] }),
    ]);
    expect((await sync.bootstrap(a, workspaceId)).streams[0]!.eventSeq).toBe(count + 1);
    expect((await sync.pull(a, workspaceId, cursorOf(workspaceId))).changes[0]!.events[0]!.event).toEqual(advanced.branches[0]!.session.events.at(-1));
    expect((await sync.management.bootstrap(a, workspaceId)).lifecycle.find((e) => e.contentId === contentId)!.value.lifecycle).toBe('trashed');
  });

  it('已归档内容回收后恢复原卷位置，原成员、摘要和义务不变', async () => {
    let local = cloudTestWorkspace(true);
    const contentId = local.entries.find((e) => e.sourceKind === 'generated')!.id;
    const volume = buildVolume(local, bridge(content, local), [contentId], '恢复夹具');
    local = attachVolume(local, volume);
    const { workspaceId } = await imported(local);
    await sync.management.submit(a, { workspaceId, commandId: randomUUID(), type: 'trash', contentId, baseVersion: 0 });
    const result = await sync.management.submit(second, { workspaceId, commandId: randomUUID(), type: 'restore', contentId, baseVersion: 1 });
    expect(result.entry.value).toEqual({ lifecycle: 'active', trashedAt: null, archiveVolumeId: volume.id });
    const original = (await imports.package(a, workspaceId)).workspace;
    expect(original.volumes).toEqual(local.volumes); expect(original.obligations).toEqual(local.obligations);
    const fresh = cloudTestWorkspace(true);
    const ambiguousId = fresh.entries.find((e) => e.sourceKind === 'generated')!.id;
    const archived = attachVolume(fresh, buildVolume(fresh, bridge(content, fresh), [ambiguousId], '第一个原卷'));
    const trashed = trashContent(archived, ambiguousId);
    const ambiguous = attachVolume(trashed, buildVolume(trashed, bridge(content, trashed), [ambiguousId], '另一个原卷'));
    const other = await imported(ambiguous);
    await expect(sync.management.submit(a, { workspaceId: other.workspaceId, commandId: randomUUID(), type: 'restore', contentId: ambiguousId, baseVersion: 0 }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CONTRACT' });
    expect((await sync.management.bootstrap(a, other.workspaceId)).lifecycle.find((e) => e.contentId === ambiguousId)!.value.lifecycle).toBe('trashed');
  });

  it('管理游标绑定工作区与代次，未来或旧代次拒绝，重新引导读取当前状态', async () => {
    const { workspaceId } = await imported(cloudTestWorkspace());
    const boot = await sync.management.bootstrap(a, workspaceId), another = await imported(cloudTestWorkspace());
    await expect(sync.management.pull(a, another.workspaceId, boot.cursor)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const parsed = JSON.parse(Buffer.from(boot.cursor, 'base64url').toString('utf8'));
    const future = Buffer.from(JSON.stringify({ ...parsed, seq: 999 })).toString('base64url');
    await expect(sync.management.pull(a, workspaceId, future)).rejects.toMatchObject({ code: 'CURSOR_EXPIRED' });
    await withClient(fixture.cluster.adminDsn, (q) => q.query('UPDATE workspaces SET sync_epoch = sync_epoch + 1 WHERE id = $1', [workspaceId]));
    await expect(sync.management.pull(a, workspaceId, boot.cursor)).rejects.toMatchObject({ code: 'CURSOR_EXPIRED' });
    const fresh = await sync.management.bootstrap(a, workspaceId);
    expect(fresh.display).toEqual(boot.display); expect(fresh.cursor).not.toBe(boot.cursor);
  });

  it('管理流写失败回滚生命周期、回执和序号，同命令可恢复', async () => {
    const local = cloudTestWorkspace(true), { workspaceId } = await imported(local);
    const contentId = local.entries.find((e) => e.sourceKind === 'generated')!.id;
    const command = { workspaceId, commandId: randomUUID(), type: 'trash' as const, contentId, baseVersion: 0 };
    await withClient(fixture.cluster.adminDsn, (q) => q.query(`
      CREATE FUNCTION fail_management_feed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic feed write failure'; END $$;
      CREATE TRIGGER synthetic_management_failure BEFORE INSERT ON management_changes FOR EACH ROW EXECUTE FUNCTION fail_management_feed();
    `));
    try { await expect(sync.management.submit(a, command)).rejects.toThrow('synthetic'); }
    finally { await withClient(fixture.cluster.adminDsn, (q) => q.query('DROP TRIGGER synthetic_management_failure ON management_changes; DROP FUNCTION fail_management_feed()')); }
    const before = await sync.management.bootstrap(a, workspaceId);
    expect(before.changeSeq).toBe(0); expect(before.lifecycle.find((e) => e.contentId === contentId)!.version).toBe(0);
    expect((await sync.management.submit(a, command)).outcome).toBe('applied');
    expect((await sync.management.bootstrap(a, workspaceId)).changeSeq).toBe(1);
  });

  it('生命周期与管理流接口保持归属、no-store和严格字段边界', async () => {
    const local = cloudTestWorkspace(true), { workspaceId } = await imported(local);
    const contentId = local.entries.find((e) => e.sourceKind === 'generated')!.id;
    const command = { workspaceId, commandId: randomUUID(), type: 'trash', contentId, baseVersion: 0 };
    const boot = await request(`/sync/management/bootstrap?workspaceId=${workspaceId}`);
    expect(boot.status).toBe(200);
    expect((await request('/sync/lifecycle', 'POST', command, cookieB)).status).toBe(404);
    expect((await request(`/sync/management/bootstrap?workspaceId=${workspaceId}`, 'GET', undefined, cookieB)).status).toBe(404);
    expect((await request('/sync/lifecycle', 'POST', { ...command, waive: true })).status).toBe(400);
    expect((await request('/sync/lifecycle', 'POST', { ...command, contentId: local.entries[0]!.id })).status).toBe(400);
    expect((await request('/sync/lifecycle', 'POST', command)).body.outcome).toBe('applied');
    const response = await fetch(`${base}/api/cloud/v1/sync/management/pull?workspaceId=${workspaceId}&cursor=${encodeURIComponent(boot.body.cursor)}`, { headers: { cookie } });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json() as any).changes[0].type).toBe('lifecycle');
    expect((await fixture.app.withTenant(b.accountId, (q) => q.query('SELECT * FROM content_lifecycle WHERE workspace_id = $1', [workspaceId]))).rows).toEqual([]);
  });
});

describe('C3 归档命令：真实 PostgreSQL 与确定性内容重放', () => {
  async function archiveCommand(local: Workspace, workspaceId: string, ids = local.entries.map((e) => e.id)): Promise<Extract<ArchiveCommand, { type: 'archive' }>> {
    const boot = await sync.management.bootstrap(a, workspaceId);
    const volume = buildVolume(local, bridge(content, local), ids, '冻结阅读前缀');
    return { workspaceId, commandId: randomUUID(), type: 'archive', volumeId: volume.id, title: volume.title,
      baseVersion: boot.archive!.version, basis: { streamId: volume.derivedFrom.branchId, eventCount: volume.derivedFrom.eventCount, eventHash: volume.derivedFrom.eventHash },
      members: volume.members.map((m) => ({ contentId: m.contentId, revisionId: m.revisionId,
        lifecycleVersion: boot.lifecycle.find((e) => e.contentId === m.contentId)!.version,
        displayVersion: boot.display.find((e) => e.contentId === m.contentId)!.version })) };
  }
  function unarchiveCommand(receipt: ArchiveReceipt, previous: ArchiveCommand): ArchiveCommand {
    return { workspaceId: previous.workspaceId, commandId: randomUUID(), type: 'unarchive', volumeId: previous.volumeId,
      baseVersion: receipt.snapshot.state.version, members: previous.members.map((m) => ({ ...m,
        lifecycleVersion: receipt.snapshot.lifecycle.find((e) => e.contentId === m.contentId)!.version,
        displayVersion: receipt.display.find((e) => e.contentId === m.contentId)!.version })) };
  }

  it('摘要与引文由库存前缀重放生成，未读集没有引文，原件/义务/事件不改写', async () => {
    const local = cloudTestWorkspace(true), { workspaceId } = await imported(local);
    const command = await archiveCommand(local, workspaceId);
    const receipt = await sync.management.archives.submit(a, command);
    expect(receipt.outcome).toBe('applied');
    const volume = receipt.snapshot.state.volumes[0] as Workspace['volumes'][number];
    const expected = buildVolume(local, bridge(content, local), command.members.map((m) => m.contentId), command.title);
    for (const key of ['members', 'reading', 'facts', 'choices', 'threads', 'quotes', 'narrative'] as const) expect(volume[key]).toEqual(expected[key]);
    const unread = local.entries.find((e) => e.sourceKind === 'generated')!;
    expect(volume.reading.find((r) => r.contentId === unread.id)!.status).toBe('unread');
    expect(volume.quotes.some((q) => q.contentId === unread.id)).toBe(false);
    expect(volume.quotes.length).toBeGreaterThan(0);
    const original = (await imports.package(a, workspaceId)).workspace;
    expect(original.volumes).toEqual([]); expect(original.obligations).toEqual(local.obligations);
    expect(original.branches).toEqual(local.branches);
    const boot = await sync.management.bootstrap(second, workspaceId);
    expect(boot.archive).toEqual(receipt.snapshot.state);
    expect(boot.lifecycle.every((e) => e.value.archiveVolumeId === command.volumeId)).toBe(true);
  });

  it('二十次相同请求只创建一个卷；丢响应恢复先查回执，不重新读取原件或重建', async () => {
    const local = cloudTestWorkspace(), { workspaceId } = await imported(local);
    const command = await archiveCommand(local, workspaceId);
    const results = await Promise.all(Array.from({ length: 20 }, () => sync.management.archives.submit(a, command)));
    for (const result of results) expect(result).toEqual(results[0]);
    expect((await sync.management.bootstrap(a, workspaceId)).changeSeq).toBe(1);
    const unavailable = new SyncService(fixture.app, async () => { throw new Error('source unavailable'); }, content);
    expect(await unavailable.management.archives.submit(a, command)).toEqual(results[0]);
    await expect(sync.management.archives.submit(a, { ...command, title: '同 ID 异文' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
  });

  it('伪造已读/引文正文或时间字段 HTTP 拒绝；错误前缀持久拒绝，不放宽来源', async () => {
    const local = cloudTestWorkspace(), { workspaceId } = await imported(local);
    const command = await archiveCommand(local, workspaceId);
    expect((await request('/sync/archives', 'POST', { ...command, quotes: [{ text: 'forged' }] })).status).toBe(400);
    expect((await request('/sync/archives', 'POST', { ...command, createdAt: '2099-01-01T00:00:00.000Z' })).status).toBe(400);
    const wrong = { ...command, basis: { ...command.basis, eventHash: 'f'.repeat(16) } };
    const rejected = await sync.management.archives.submit(a, wrong);
    expect(rejected).toMatchObject({ outcome: 'rejected', reason: 'basis', snapshot: { state: { version: 0, volumes: [] } } });
    expect(await sync.management.archives.submit(a, wrong)).toEqual(rejected);
    expect((await sync.management.bootstrap(a, workspaceId)).changeSeq).toBe(0);
    const accepted = await sync.management.archives.submit(a, { ...command, commandId: randomUUID() });
    expect((accepted.snapshot.state.volumes[0] as Workspace['volumes'][number]).quotes).toEqual([]);
  });

  it('两个归档并发只有一个成功；归档与回收竞争按生命周期前置版本裁决', async () => {
    const local = cloudTestWorkspace(true), { workspaceId } = await imported(local);
    const generated = local.entries.find((e) => e.sourceKind === 'generated')!;
    const command = await archiveCommand(local, workspaceId, [generated.id]);
    const result = await Promise.all([sync.management.archives.submit(a, command), sync.management.archives.submit(second, { ...command, commandId: randomUUID(), volumeId: `vol_${randomUUID()}` })]);
    expect(result.map((r) => r.outcome).sort()).toEqual(['applied', 'conflict']);
    const fresh = cloudTestWorkspace(true), own = await imported(fresh), entry = fresh.entries.find((e) => e.sourceKind === 'generated')!;
    const other = await archiveCommand(fresh, own.workspaceId, [entry.id]);
    const race = await Promise.all([sync.management.archives.submit(a, other), sync.management.submit(second, { workspaceId: own.workspaceId, commandId: randomUUID(), type: 'trash', contentId: entry.id, baseVersion: 0 })]);
    expect(race.map((r) => r.outcome).sort()).toEqual(['applied', 'conflict']);
    expect((await sync.management.bootstrap(a, own.workspaceId)).changeSeq).toBe(1);
  });

  it('取消归档更新当前图和恢复位置，之后回收/恢复不会复活已取消的卷', async () => {
    const local = cloudTestWorkspace(true), { workspaceId } = await imported(local);
    const generated = local.entries.find((e) => e.sourceKind === 'generated')!;
    const command = await archiveCommand(local, workspaceId, [generated.id]);
    const accepted = await sync.management.archives.submit(a, command);
    const removed = await sync.management.archives.submit(second, unarchiveCommand(accepted, command));
    expect(removed.outcome).toBe('applied'); expect(removed.snapshot.state.volumes).toEqual([]);
    expect(removed.snapshot.lifecycle.find((e) => e.contentId === generated.id)!.value.archiveVolumeId).toBeNull();
    await sync.management.submit(a, { workspaceId, commandId: randomUUID(), type: 'trash', contentId: generated.id, baseVersion: 2 });
    expect((await sync.management.submit(second, { workspaceId, commandId: randomUUID(), type: 'restore', contentId: generated.id, baseVersion: 3 })).entry.value.archiveVolumeId).toBeNull();
    expect(await sync.management.archives.submit(second, unarchiveCommand(accepted, command))).toMatchObject({ outcome: 'conflict' });
  });

  it('归档管理流写失败回滚卷、成员版本、回执和序号；原请求可恢复', async () => {
    const local = cloudTestWorkspace(), { workspaceId } = await imported(local), command = await archiveCommand(local, workspaceId);
    await withClient(fixture.cluster.adminDsn, (q) => q.query(`
      CREATE FUNCTION fail_archive_feed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic archive failure'; END $$;
      CREATE TRIGGER archive_feed_failure BEFORE INSERT ON management_changes FOR EACH ROW EXECUTE FUNCTION fail_archive_feed();`));
    try { await expect(sync.management.archives.submit(a, command)).rejects.toThrow('synthetic'); }
    finally { await withClient(fixture.cluster.adminDsn, (q) => q.query('DROP TRIGGER archive_feed_failure ON management_changes; DROP FUNCTION fail_archive_feed()')); }
    const boot = await sync.management.bootstrap(a, workspaceId);
    expect(boot.archive).toEqual({ version: 0, volumes: [] }); expect(boot.changeSeq).toBe(0);
    expect(boot.lifecycle.every((e) => e.version === 0)).toBe(true);
    expect((await sync.management.archives.submit(a, command)).outcome).toBe('applied');
  });

  it('旧图达到 500 卷时拒绝新增而不删旧卷；大型管理页按字节边界分页且不漏序号', async () => {
    const local = cloudTestWorkspace(true), { workspaceId } = await imported(local);
    const generated = local.entries.find((e) => e.sourceKind === 'generated')!;
    await sync.management.submit(a, { workspaceId, commandId: randomUUID(), type: 'trash', contentId: generated.id, baseVersion: 0 });
    const prototype = buildVolume(local, bridge(content, local), [generated.id], '有界传输夹具');
    // A legal legacy graph can retain many references to a trashed item. This is a synthetic transport fixture, not a performance measurement.
    const volumes = Array.from({ length: 500 }, () => ({ ...prototype, id: `vol_${randomUUID()}`, narrative: prototype.narrative.padEnd(2000, ' ') }));
    await fixture.app.withTenant(a.accountId, (q) => q.query('UPDATE workspace_archives SET volumes = $3 WHERE account_id = $1 AND workspace_id = $2', [a.accountId, workspaceId, JSON.stringify(volumes)]));
    const command = await archiveCommand(local, workspaceId, [local.entries[0]!.id]);
    const rejected = await sync.management.archives.submit(a, command);
    expect(rejected).toMatchObject({ outcome: 'rejected', reason: 'capacity' });
    expect(rejected.snapshot.state.volumes).toHaveLength(500);
    const boot = await sync.management.bootstrap(a, workspaceId);
    expect(boot.changeSeq).toBe(1);
    await fixture.app.withTenant(a.accountId, async (q) => {
      await q.query('SELECT account_id FROM account_control WHERE account_id = $1 FOR UPDATE', [a.accountId]);
      await q.query('SELECT id FROM workspaces WHERE account_id = $1 AND id = $2 FOR UPDATE', [a.accountId, workspaceId]);
      for (const version of [1, 2]) {
        const commandId = randomUUID();
        await q.query(`INSERT INTO metadata_commands (account_id, workspace_id, command_id, device_id, request_digest, request, receipt)
          VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, '{}'::jsonb)`, [a.accountId, workspaceId, commandId, a.deviceId, sha({ fixture: version })]);
        await recordManagement(q, a.accountId, workspaceId, commandId, { type: 'archive', snapshot: { state: { version, volumes }, lifecycle: boot.lifecycle } });
      }
    });
    const first = await sync.management.pull(a, workspaceId, boot.cursor, 100);
    expect(first.changes.map((c) => c.seq)).toEqual([2]); expect(first.hasMore).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(2_097_152);
    const secondPage = await sync.management.pull(a, workspaceId, first.nextCursor, 100);
    expect(secondPage.changes.map((c) => c.seq)).toEqual([3]); expect(secondPage.hasMore).toBe(false);
  });

  it('归档归属与只读边界保持，超过当前 10k 重放容量明确拒绝不截断', async () => {
    const local = cloudTestWorkspace(), { workspaceId } = await imported(local), command = await archiveCommand(local, workspaceId);
    expect((await request('/sync/archives', 'POST', command, cookieB)).status).toBe(404);
    await withClient(fixture.cluster.adminDsn, (q) => q.query('UPDATE sync_streams SET event_seq = 10001, last_event_id = $2 WHERE workspace_id = $1', [workspaceId, randomUUID()]));
    expect(await sync.management.archives.submit(a, command)).toMatchObject({ outcome: 'rejected', reason: 'basis' });
    const rows = await fixture.app.withTenant(b.accountId, (q) => q.query('SELECT * FROM workspace_archives WHERE workspace_id = $1', [workspaceId]));
    expect(rows.rows).toEqual([]);
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

describe('分叉流注册：本机新建分支接进云端', () => {
  const register = (workspaceId: string, streamId: StreamId, parentStreamId: StreamId, forkAtSeq: number) =>
    sync.registerStream(a, { workspaceId, streamId, parentStreamId, forkAtSeq });

  it('注册复制父流前缀成员关系，不复制事件正文；之后的事件只能接在分叉点之后', async () => {
    const local = cloudTestWorkspace();
    const { workspaceId, bootstrap } = await imported(local);
    const root = streamOf(local);
    const prefix = entries(play(local, { limit: 2 }));
    await sync.push(a, {
      workspaceId, batchId: randomUUID(), baseVersion: bootstrap.cloudVersion,
      streams: [{ streamId: root, baseSeq: 0, baseEventId: null, events: prefix }],
    });

    const child = `brn_${randomUUID()}` as StreamId;
    const registered = await register(workspaceId, child, root, 1);
    expect(registered.stream).toMatchObject({ streamId: child, branchId: child, eventSeq: 1, lastEventId: prefix[0]!.eventId });

    const counts = await withClient(fixture.cluster.adminDsn, (q) => q.query<{ members: number; bodies: number }>(
      `SELECT (SELECT count(*)::int FROM stream_events WHERE workspace_id = $1 AND stream_id = $2) AS members,
              (SELECT count(*)::int FROM event_objects WHERE workspace_id = $1) AS bodies`,
      [workspaceId, child],
    ));
    // 前缀成员关系被复制，事件正文仍只有父流那两份
    expect(counts.rows[0]).toEqual({ members: 1, bodies: 2 });

    const tail = { ...prefix[1]!, eventId: randomUUID(), seq: 2 };
    const pushed = await sync.push(a, {
      workspaceId, batchId: randomUUID(), baseVersion: bootstrap.cloudVersion,
      streams: [{ streamId: child, baseSeq: 1, baseEventId: prefix[0]!.eventId, events: [tail] }],
    });
    expect(pushed.receipt.streams[0]).toMatchObject({ eventSeq: 2, lastEventId: tail.eventId });
    // 用同账号的第二台设备拉取：跨账号看不到别人的工作区
    const changes = await sync.pull(second, workspaceId, cursorOf(workspaceId), 20);
    expect(changes.changes.at(-1)!.streamId).toBe(child);
    expect(changes.changes.at(-1)!.events[0]!.eventId).toBe(tail.eventId);
  });

  it('同参数重复注册幂等；参数不同拒绝改绑，不静默换父流', async () => {
    const { workspaceId } = await imported(play(cloudTestWorkspace(), { limit: 2 }));
    const root = streamOf(cloudTestWorkspace());
    // 父流来自另一个工作区时不存在，这里用引导拿到的流
    const boot = await sync.bootstrap(a, workspaceId);
    const parent = boot.streams[0]!;
    const child = `brn_${randomUUID()}` as StreamId;
    const first = await register(workspaceId, child, parent.streamId, 1);
    const again = await register(workspaceId, child, parent.streamId, 1);
    expect(again.stream).toEqual(first.stream);
    await expect(register(workspaceId, child, parent.streamId, 2)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(register(workspaceId, child, `brn_${randomUUID()}` as StreamId, 1)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    void root;
  });

  it('分叉点不能超出父流已推送的历史；父流不存在时拒绝而不创建', async () => {
    const local = play(cloudTestWorkspace(), { limit: 1 });
    const { workspaceId } = await imported(local);
    const boot = await sync.bootstrap(a, workspaceId);
    const parent = boot.streams[0]!;
    const child = `brn_${randomUUID()}` as StreamId;
    await expect(register(workspaceId, child, parent.streamId, parent.eventSeq + 1)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(register(workspaceId, `brn_${randomUUID()}` as StreamId, `brn_${randomUUID()}` as StreamId, 0))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await sync.bootstrap(a, workspaceId)).streams.map((stream) => stream.streamId)).toEqual([parent.streamId]);
  });

  it('分叉点 0 注册成一条独立根流，可从第一条事件开始推送', async () => {
    const local = cloudTestWorkspace();
    const { workspaceId, bootstrap } = await imported(local);
    const root = streamOf(local);
    const child = `brn_${randomUUID()}` as StreamId;
    const registered = await register(workspaceId, child, root, 0);
    expect(registered.stream).toMatchObject({ eventSeq: 0, lastEventId: null });

    const first = { ...entries(play(local, { limit: 1 }))[0]!, seq: 1 };
    const pushed = await sync.push(a, {
      workspaceId, batchId: randomUUID(), baseVersion: bootstrap.cloudVersion,
      streams: [{ streamId: child, baseSeq: 0, baseEventId: null, events: [first] }],
    });
    expect(pushed.receipt.applied).toBe(1);
  });

  it('跨账号不能往别人的工作区注册流', async () => {
    const local = play(cloudTestWorkspace(), { limit: 1 });
    const { workspaceId } = await imported(local);
    const boot = await sync.bootstrap(a, workspaceId);
    await expect(sync.registerStream(b, {
      workspaceId, streamId: `brn_${randomUUID()}` as StreamId,
      parentStreamId: boot.streams[0]!.streamId, forkAtSeq: 0,
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
