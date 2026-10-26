import { createHash } from 'node:crypto';
import { contentHash, stableStringify } from '@endless/esl';
import { ArchiveVolumeSchema, bridge, buildVolume, type ArchiveVolume, type Content, type Workspace } from '@endless/content';
import {
  ArchiveCommandSchema, ArchiveReceiptSchema, LifecycleEntrySchema, MetadataEntrySchema, SyncBranchManifestSchema, CLOUD_LIMITS,
  type ArchiveCommand, type ArchiveReceipt, type ArchiveSnapshot, type ArchiveState, type LifecycleEntry, type MetadataEntry,
} from '@endless/cloud-contracts';
import type { AuthContext } from '../auth/service.js';
import type { CloudPool, Querier } from '../db/client.js';
import { CloudError, idempotencyMismatch, notFound } from '../errors.js';
import { recordManagement } from './management-feed.js';
import { revisionCatalog, withRegisteredRevisions } from './revision-registry.js';

const MAX_BYTES = CLOUD_LIMITS.uploadObjectBytes - 4096;
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const quota = () => new CloudError(413, 'STORAGE_QUOTA', 'sync', '归档结果超过当前有界同步容量；原卷和原请求保留，不会删除历史来腾空间', 'contact_support');
const unsupported = (message: string) => new CloudError(409, 'UNSUPPORTED_CONTRACT', 'sync', message, 'contact_support');

export async function seedArchives(q: Querier, accountId: string, workspaceId: string, copy: Workspace) {
  await q.query('INSERT INTO workspace_archives (account_id, workspace_id, volumes, origin_volumes) VALUES ($1, $2, $3, $3) ON CONFLICT DO NOTHING',
    [accountId, workspaceId, JSON.stringify(copy.volumes)]);
}
export async function archiveSnapshot(q: Querier, ctx: AuthContext, workspaceId: string): Promise<ArchiveSnapshot> {
  const row = (await q.query<{ version: string; volumes: unknown[] }>('SELECT version, volumes FROM workspace_archives WHERE account_id = $1 AND workspace_id = $2', [ctx.accountId, workspaceId])).rows[0];
  if (!row) throw unsupported('工作区缺少可验证的归档基线，原件保留');
  const volumes = ArchiveVolumeSchema.array().max(500).parse(row.volumes);
  if (stableStringify(volumes) !== stableStringify(row.volumes)) throw unsupported('归档正文存在未知字段，原件保留');
  const rows = await q.query<{ content_id: string; source_kind: string; version: string; value: unknown; updated_at: Date }>(
    'SELECT * FROM content_lifecycle WHERE account_id = $1 AND workspace_id = $2 ORDER BY content_id LIMIT 2001', [ctx.accountId, workspaceId]);
  if (rows.rows.length > 2000) throw unsupported('归档成员超过当前容量，不能截断同步');
  return { state: { version: Number(row.version), volumes }, lifecycle: rows.rows.map((r) => LifecycleEntrySchema.parse({
    contentId: r.content_id, sourceKind: r.source_kind, version: Number(r.version), value: r.value, updatedAt: r.updated_at.toISOString(),
  })) };
}

export class ArchiveService {
  constructor(private readonly app: CloudPool, private readonly source: ((ctx: AuthContext, id: string) => Promise<Workspace>) | undefined,
    private readonly content: Content | undefined, private readonly gate: {
      lock(q: Querier, ctx: AuthContext, id: string): Promise<number>;
      ensure(ctx: AuthContext, id: string): Promise<void>;
    }) {}

  async ensure(ctx: AuthContext, workspaceId: string) {
    const exists = await this.app.withTenant(ctx.accountId, async (q) => {
      await this.gate.lock(q, ctx, workspaceId);
      return (await q.query('SELECT 1 FROM workspace_archives WHERE account_id = $1 AND workspace_id = $2', [ctx.accountId, workspaceId])).rowCount;
    });
    if (exists) return;
    const copy = await this.source?.(ctx, workspaceId);
    if (!copy) throw unsupported('旧工作区缺少已验证归档原件，不能猜测或清空卷');
    await this.app.withTenant(ctx.accountId, async (q) => {
      await this.gate.lock(q, ctx, workspaceId); await seedArchives(q, ctx.accountId, workspaceId, copy);
    });
  }

  private async held(q: Querier, ctx: AuthContext, input: ArchiveCommand, digest: string) {
    const row = (await q.query<{ request_digest: string; receipt: unknown }>('SELECT request_digest, receipt FROM metadata_commands WHERE account_id = $1 AND command_id = $2', [ctx.accountId, input.commandId])).rows[0];
    if (!row) return null;
    if (row.request_digest !== digest) throw idempotencyMismatch();
    return ArchiveReceiptSchema.parse(row.receipt);
  }

  async submit(ctx: AuthContext, raw: ArchiveCommand): Promise<ArchiveReceipt> {
    const input = ArchiveCommandSchema.parse(raw), digest = createHash('sha256').update(stableStringify(input)).digest('hex');
    const held = await this.app.withTenant(ctx.accountId, async (q) => { await this.gate.lock(q, ctx, input.workspaceId); return this.held(q, ctx, input, digest); });
    if (held) return held;
    await this.gate.ensure(ctx, input.workspaceId); await this.ensure(ctx, input.workspaceId);
    // Object reads happen outside retried DB transactions. Replays of an already saved command never need this source read.
    const source = input.type === 'archive' ? await this.source?.(ctx, input.workspaceId) : undefined;
    if (input.type === 'archive' && (!source || !this.content)) throw unsupported('当前部署没有可验证的内容上下文，未创建归档');
    return this.app.withTenant(ctx.accountId, async (q) => {
      await this.gate.lock(q, ctx, input.workspaceId);
      const duplicate = await this.held(q, ctx, input, digest); if (duplicate) return duplicate;
      let snapshot = await archiveSnapshot(q, ctx, input.workspaceId);
      const display = await this.displays(q, ctx, input);
      const positions = new Map(snapshot.lifecycle.map((e) => [e.contentId, e]));
      const names = new Map(display.map((e) => [e.contentId, e]));
      if (input.members.some((m) => !positions.has(m.contentId) || !names.has(m.contentId))) throw notFound('归档内容不存在');
      let outcome: ArchiveReceipt['outcome'] = 'applied';
      let reason: ArchiveReceipt['reason'];
      if (input.baseVersion !== snapshot.state.version || input.members.some((m) => positions.get(m.contentId)!.version !== m.lifecycleVersion || names.get(m.contentId)!.version !== m.displayVersion)) {
        outcome = 'conflict'; reason = 'precondition';
      }
      const current = snapshot.state.volumes as ArchiveVolume[];
      let next = current;
      if (outcome === 'applied') {
        if (input.type === 'unarchive') {
          const volume = current.find((v) => v.id === input.volumeId);
          if (!volume || stableStringify(volume.members.map((m) => ({ contentId: m.contentId, revisionId: m.revisionId }))) !== stableStringify(input.members.map((m) => ({ contentId: m.contentId, revisionId: m.revisionId })))) {
            outcome = 'rejected'; reason = 'members';
          } else next = current.filter((v) => v.id !== input.volumeId);
        } else if (current.some((v) => v.id === input.volumeId) || input.members.some((m) => positions.get(m.contentId)!.value.lifecycle !== 'active'
          || current.some((v) => v.members.some((n) => n.contentId === m.contentId)))) {
          outcome = 'rejected'; reason = 'members';
        } else {
          const expanded = withRegisteredRevisions(source!, await revisionCatalog(q, ctx, input.workspaceId));
          const volume = await this.build(q, ctx, input, expanded, display);
          if (!volume) { outcome = 'rejected'; reason = 'basis'; }
          else next = [...current, volume];
        }
      }
      if (outcome === 'applied' && (next.length > 500 || size({ volumes: next, lifecycle: snapshot.lifecycle, display }) > MAX_BYTES - 8192)) {
        outcome = 'rejected'; reason = 'capacity';
      }
      if (outcome === 'applied') {
        const time = new Date().toISOString();
        for (const member of input.members) {
          const memberships = next.filter((v) => v.members.some((m) => m.contentId === member.contentId));
          const prior = positions.get(member.contentId)!;
          const archiveVolumeId = prior.value.lifecycle === 'active' ? memberships[0]?.id ?? null : null;
          await q.query(`UPDATE content_lifecycle SET version = version + 1, value = $4, restore_archive_id = $5, restore_ambiguous = $6, updated_at = $7
            WHERE account_id = $1 AND workspace_id = $2 AND content_id = $3`,
          [ctx.accountId, input.workspaceId, member.contentId, JSON.stringify({ ...prior.value, archiveVolumeId }), memberships[0]?.id ?? null, memberships.length > 1, time]);
        }
        await q.query('UPDATE workspace_archives SET version = version + 1, volumes = $3 WHERE account_id = $1 AND workspace_id = $2', [ctx.accountId, input.workspaceId, JSON.stringify(next)]);
        snapshot = await archiveSnapshot(q, ctx, input.workspaceId);
      }
      const receipt: ArchiveReceipt = { workspaceId: input.workspaceId, commandId: input.commandId, outcome, ...(reason ? { reason } : {}), snapshot, display };
      if (size(receipt) > MAX_BYTES) throw quota();
      await q.query(`INSERT INTO metadata_commands (account_id, workspace_id, command_id, device_id, request_digest, request, receipt)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`, [ctx.accountId, input.workspaceId, input.commandId, ctx.deviceId, digest, JSON.stringify(input), JSON.stringify(receipt)]);
      if (outcome === 'applied') await recordManagement(q, ctx.accountId, input.workspaceId, input.commandId, { type: 'archive', snapshot });
      return receipt;
    });
  }

  private async displays(q: Querier, ctx: AuthContext, input: ArchiveCommand): Promise<MetadataEntry[]> {
    const rows = await q.query<{ content_id: string; version: string; value: unknown; updated_at: Date }>(
      'SELECT * FROM content_metadata WHERE account_id = $1 AND workspace_id = $2 AND content_id = ANY($3::text[]) ORDER BY content_id', [ctx.accountId, input.workspaceId, input.members.map((m) => m.contentId)]);
    return rows.rows.map((r) => MetadataEntrySchema.parse({ contentId: r.content_id, version: Number(r.version), value: r.value, updatedAt: r.updated_at.toISOString() }));
  }

  private async build(q: Querier, ctx: AuthContext, input: Extract<ArchiveCommand, { type: 'archive' }>, source: Workspace, display: MetadataEntry[]): Promise<ArchiveVolume | null> {
    const stream = (await q.query<{ branch_manifest: unknown; event_seq: string }>('SELECT branch_manifest, event_seq FROM sync_streams WHERE account_id = $1 AND workspace_id = $2 AND stream_id = $3 FOR UPDATE',
      [ctx.accountId, input.workspaceId, input.basis.streamId])).rows[0];
    if (!stream || Number(stream.event_seq) > 10_000 || Number(stream.event_seq) < input.basis.eventCount) return null;
    const manifest = SyncBranchManifestSchema.safeParse(stream.branch_manifest);
    if (!manifest.success || input.members.some((m) => !manifest.data.adopted.some((a) => a.contentId === m.contentId && a.revisionId === m.revisionId))) return null;
    const events = await q.query<{ event_seq: string; body: Workspace['branches'][number]['session']['events'][number]; digest: string }>(
      `SELECT se.event_seq, e.body, e.digest FROM stream_events se JOIN event_objects e USING (account_id, workspace_id, event_id)
       WHERE se.account_id = $1 AND se.workspace_id = $2 AND se.stream_id = $3 ORDER BY se.event_seq`, [ctx.accountId, input.workspaceId, input.basis.streamId]);
    if (events.rows.length !== Number(stream.event_seq) || events.rows.some((e, i) => Number(e.event_seq) !== i + 1
      || createHash('sha256').update(stableStringify(e.body)).digest('hex') !== e.digest)) return null;
    try {
      const first = source.revisions.find((r) => r.id === manifest.data.adopted[0]!.revisionId); if (!first) return null;
      const branch: Workspace['branches'][number] = { id: input.basis.streamId, label: manifest.data.label,
        parentBranchId: manifest.data.parentBranchId, forkAtEventCount: manifest.data.forkAtEventCount, adopted: manifest.data.adopted, createdAt: manifest.data.createdAt,
        session: { version: 1, catalog: manifest.data.catalog, current: first.episodeId, largeText: false, revision: 0, events: events.rows.map((e) => e.body) } };
      const workspace = { ...source, activeBranchId: branch.id, branches: [...source.branches.filter((b) => b.id !== branch.id), branch],
        entries: source.entries.map((e) => { const name = display.find((d) => d.contentId === e.id); return name ? { ...e, display: { ...e.display, ...name.value } } : e; }) };
      const runtime = bridge(this.content!, workspace, branch.id);
      runtime.session = { ...runtime.session, events: runtime.session.events.slice(0, input.basis.eventCount) };
      if (contentHash({ catalog: runtime.session.catalog, events: runtime.session.events }) !== input.basis.eventHash) return null;
      const volume = buildVolume(workspace, runtime, input.members.map((m) => m.contentId), input.title);
      return ArchiveVolumeSchema.parse({ ...volume, id: input.volumeId });
    } catch { return null; }
  }
}
