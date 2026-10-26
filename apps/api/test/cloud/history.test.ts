import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { applyPlayerCommand, bridge, buildBackup, validateCloudBackup, type Workspace } from '@endless/content';
import { exportReplay, getOptions, getScenes, libraryLoader, replayEvents, type PlayerEvent } from '@endless/player';
import { AuthService, type AuthContext } from '../../src/cloud/auth/service.js';
import { cloudCapabilities } from '../../src/cloud/capabilities.js';
import { OutboxMailer, readQueuedMail } from '../../src/cloud/mail.js';
import { ObjectService } from '../../src/cloud/objects/service.js';
import { S3ObjectStorage } from '../../src/cloud/objects/storage.js';
import { ImportService } from '../../src/cloud/imports/service.js';
import { HistoryService, REPLAY_VERIFY_EVENT_LIMIT } from '../../src/cloud/history/service.js';
import { cloudFixture, TEST_MAIL_KEY, TEST_PEPPER } from './fixtures.js';
import { withClient } from './embedded-pg.js';
import { fakeObjectStorage, S3_CREDENTIALS } from './object-storage-fixture.js';
import { cloudTestContent as content, cloudTestWorkspace } from '../../../../packages/content/test/cloud-fixture.js';

let fixture: Awaited<ReturnType<typeof cloudFixture>>;
let s3: Awaited<ReturnType<typeof fakeObjectStorage>>;
let storage: S3ObjectStorage;
let imports: ImportService;
let history: HistoryService;
let a: AuthContext;
let b: AuthContext;

const episode = content.pilot.episodes[0]!;
const scenes = getScenes(episode);
const optionScene = scenes.find((scene) => getOptions(scene).length)!;
const correct = getOptions(optionScene).findIndex((choice) => choice.correct);

function play(start: Workspace, limit: number) {
  const at = (index: number) => new Date(Date.parse('2026-10-24T09:00:00.000Z') + index * 1000).toISOString();
  let workspace = applyPlayerCommand(content, start, { type: 'select', episode: episode.id }, new Date(at(0)));
  let tick = 1;
  for (const scene of getScenes(episode)) {
    if (workspace.branches[0]!.session.events.length >= limit) break;
    if (getOptions(scene).length) {
      workspace = applyPlayerCommand(content, workspace, {
        type: 'answer', scene: scene.id, choice: correct,
      }, new Date(at(tick++)));
    }
    if (workspace.branches[0]!.session.events.length >= limit) break;
    workspace = applyPlayerCommand(content, workspace, { type: 'advance', scene: scene.id, skip: false }, new Date(at(tick++)));
  }
  return workspace;
}

beforeAll(async () => {
  fixture = await cloudFixture();
  s3 = await fakeObjectStorage();
  storage = new S3ObjectStorage({ endpoint: s3.endpoint, bucket: 'synthetic-bucket', region: 'test-1', ...S3_CREDENTIALS });
  const objects = new ObjectService(fixture.app, storage, fixture.deployment, {
    quotaBytes: 16_777_216,
    backupValidator: (raw) => { validateCloudBackup(content, raw); },
  });
  imports = new ImportService(fixture.app, objects, content, fixture.deployment);
  history = new HistoryService(fixture.app);
  const auth = new AuthService(fixture.auth, new OutboxMailer(TEST_MAIL_KEY), TEST_PEPPER);
  const login = async () => {
    const email = `${randomUUID()}@example.test`;
    const challenge = await auth.issueChallenge({ email, ip: randomUUID() }, 'history-test');
    const code = /验证码是 (\d{6})/.exec((await readQueuedMail(fixture.auth, email, TEST_MAIL_KEY))[0]!.body)![1]!;
    const session = await auth.verifyChallenge({ challengeId: challenge.challengeId, email, code }, 'history-test');
    return (await auth.resolveSession(session.token))!;
  };
  a = await login();
  b = await login();
}, 120_000);

afterAll(async () => {
  storage?.close();
  await s3?.close();
  await fixture?.close();
}, 60_000);

async function imported(workspace: Workspace) {
  const bytes = Buffer.from(JSON.stringify(buildBackup(workspace)));
  const preview = await imports.preview(a, bytes, randomUUID());
  const receipt = (await imports.activate(a, {
    previewId: preview.preview.id, snapshotDigest: preview.preview.snapshotDigest, validationBinding: preview.preview.validationBinding,
  }, randomUUID())).receipt;
  return receipt.workspaceId;
}

async function rowsOf(accountId: string, workspaceId: string) {
  const found = await fixture.app.withTenant(accountId, (q) => q.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM replay_checkpoints WHERE workspace_id = $1',
    [workspaceId],
  ));
  return found.rows[0]!.n;
}

describe('C4 服务端重放检查点：真实 PostgreSQL', () => {
  it('不挂出导出或生成能力', () => {
    expect(cloudCapabilities({ objects: true, imports: true, sync: true }).features).toMatchObject({
      exports: false, generation: false, edition: false, credits: false, billing: false, payments: false,
    });
    expect(REPLAY_VERIFY_EVENT_LIMIT).toBe(100_000);
  });

  it('谎报、旧投影和超限都不写入；同一摘要可重复，另一账号看不见', async () => {
    const local = play(cloudTestWorkspace(), 3);
    const runtime = bridge(content, local);
    const workspaceId = await imported(local);
    const streamId = local.branches[0]!.id;
    const input = { workspaceId, streamId, library: runtime.library };

    await withClient(fixture.cluster.adminDsn, (q) => q.query(
      'UPDATE sync_streams SET event_seq = $1 WHERE account_id = $2 AND workspace_id = $3 AND stream_id = $4',
      [REPLAY_VERIFY_EVENT_LIMIT + 1, a.accountId, workspaceId, streamId],
    ));
    await expect(history.verifyStream(a.accountId, input)).rejects.toMatchObject({ status: 409, code: 'UNSUPPORTED_CONTRACT' });
    const kept = await fixture.app.withTenant(a.accountId, (q) => q.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM stream_events WHERE account_id = $1 AND workspace_id = $2 AND stream_id = $3',
      [a.accountId, workspaceId, streamId],
    ));
    expect(kept.rows[0]!.n).toBe(3);
    await withClient(fixture.cluster.adminDsn, (q) => q.query(
      'UPDATE sync_streams SET event_seq = $1 WHERE account_id = $2 AND workspace_id = $3 AND stream_id = $4',
      [3, a.accountId, workspaceId, streamId],
    ));

    await expect(history.verifyStream(a.accountId, {
      ...input, claimed: { projectorVersion: 'player-replay-1', completed: 999 },
    })).rejects.toMatchObject({ status: 422, code: 'CONTENT_REJECTED' });
    await expect(history.verifyStream(a.accountId, {
      ...input, claimed: { projectorVersion: 'player-projection-1' },
    })).rejects.toMatchObject({ status: 409, code: 'UNSUPPORTED_CONTRACT' });
    expect(await rowsOf(a.accountId, workspaceId)).toBe(0);

    const first = await history.verifyStream(a.accountId, input);
    expect(first.eventCount).toBe(3);
    expect(first.eventHash).toMatch(/^[a-f0-9]{16}$/);
    expect(first.inline).toBe(true);
    const again = await history.verifyStream(a.accountId, input);
    expect(again.digest).toBe(first.digest);
    expect(await rowsOf(a.accountId, workspaceId)).toBe(1);

    const bodies = await fixture.app.withTenant(a.accountId, (q) => q.query<{ body: PlayerEvent }>(
      `SELECT e.body FROM stream_events se
       JOIN event_objects e USING (account_id, workspace_id, event_id)
       WHERE se.account_id = $1 AND se.workspace_id = $2 AND se.stream_id = $3
       ORDER BY se.event_seq`,
      [a.accountId, workspaceId, streamId],
    ));
    const events = bodies.rows.map((row) => row.body);
    const claimed = exportReplay(replayEvents(libraryLoader(runtime.library), events), runtime.library.version, events);
    const matched = await history.verifyStream(a.accountId, { ...input, claimed });
    expect(matched.digest).toBe(first.digest);

    await withClient(fixture.cluster.adminDsn, (q) => q.query(
      'UPDATE replay_checkpoints SET snapshot_digest = $1 WHERE account_id = $2 AND workspace_id = $3',
      ['ab'.repeat(32), a.accountId, workspaceId],
    ));
    await expect(history.verifyStream(a.accountId, input)).rejects.toMatchObject({ status: 409, code: 'SYNC_CONFLICT' });
    expect(await rowsOf(a.accountId, workspaceId)).toBe(1);
    expect(await rowsOf(b.accountId, workspaceId)).toBe(0);
    expect((await fixture.app.query('SELECT snapshot_digest FROM replay_checkpoints')).rows).toEqual([]);
  });

  it('空历史也可以留下服务端检查点', async () => {
    const local = cloudTestWorkspace();
    const runtime = bridge(content, local);
    const workspaceId = await imported(local);
    const result = await history.verifyStream(a.accountId, {
      workspaceId, streamId: local.branches[0]!.id, library: runtime.library,
    });
    expect(result).toMatchObject({ eventCount: 0, inline: true });
    expect(await rowsOf(a.accountId, workspaceId)).toBe(1);
  });
});
