import { createHash, randomUUID } from 'node:crypto';
import { stableStringify } from '@endless/esl';
import {
  adoptRevision, bridge, checked, ContentRevisionSchema, previewRevision,
  type Branch, type Content, type ContentRevision, type Workspace,
} from '@endless/content';
import { libraryLoader, replayEvents } from '@endless/player';
import {
  CLOUD_LIMITS, RevisionPreviewRequestSchema, RevisionPreviewReceiptSchema,
  SyncBranchManifestSchema, SyncPlayerEventSchema,
  type RevisionPreviewRequest, type RevisionPreviewReceipt, type SyncBranchManifest,
} from '@endless/cloud-contracts';
import type { AuthContext } from '../auth/service.js';
import type { CloudPool, Querier } from '../db/client.js';
import { CloudError, idempotencyMismatch, notFound } from '../errors.js';
import { archiveSnapshot } from './archives.js';

const sha = (value: unknown) => createHash('sha256').update(stableStringify(value)).digest('hex');
const unsupported = () => new CloudError(409, 'UNSUPPORTED_CONTRACT', 'sync', '当前部署缺少可验证的修订上下文；原内容与请求保留', 'contact_support');
const quota = () => new CloudError(413, 'STORAGE_QUOTA', 'sync', '修订预览超过当前容量；旧预览和原历史保留', 'contact_support');
const LIMIT = { previews: 64, streams: 16, events: 10_000, revisions: 64, entries: 500 };
const MAX_BYTES = CLOUD_LIMITS.uploadObjectBytes - 4096;

interface Reservation {
  request_digest: string; revision_id: string; branch_id: string; authored_at: Date; receipt: unknown | null;
}
class Rejected extends Error {
  constructor(readonly reason: 'history' | 'capacity' | 'members') { super(reason); }
}

/** Compilation has no provider/network calls. It never activates its candidate or writes learning history. */
export class RevisionPreviewService {
  constructor(private readonly app: CloudPool,
    private readonly source: ((ctx: AuthContext, id: string) => Promise<Workspace>) | undefined,
    private readonly content: Content | undefined,
    private readonly gate: {
      lock(q: Querier, ctx: AuthContext, id: string): Promise<number>;
      ensure(ctx: AuthContext, id: string): Promise<void>;
    }) {}

  private async held(q: Querier, ctx: AuthContext, input: RevisionPreviewRequest, digest: string) {
    const row = (await q.query<Reservation>('SELECT * FROM revision_previews WHERE account_id = $1 AND request_id = $2', [ctx.accountId, input.requestId])).rows[0];
    if (row && row.request_digest !== digest) throw idempotencyMismatch();
    return row;
  }

  async submit(ctx: AuthContext, raw: RevisionPreviewRequest): Promise<RevisionPreviewReceipt> {
    const input = RevisionPreviewRequestSchema.parse(raw), digest = sha(input);
    // Reserve identities before source reads/compilation. An interrupted explicit retry keeps these identities and time.
    const reserved = await this.app.withTenant(ctx.accountId, async (q) => {
      await this.gate.lock(q, ctx, input.workspaceId);
      const row = await this.held(q, ctx, input, digest); if (row) return row;
      const count = (await q.query<{ count: string }>('SELECT count(*) AS count FROM revision_previews WHERE account_id = $1 AND workspace_id = $2', [ctx.accountId, input.workspaceId])).rows[0]!;
      if (Number(count.count) >= LIMIT.previews) throw quota();
      return (await q.query<Reservation>(`INSERT INTO revision_previews
        (account_id, workspace_id, request_id, device_id, request_digest, request, revision_id, branch_id, authored_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now()) RETURNING *`,
      [ctx.accountId, input.workspaceId, input.requestId, ctx.deviceId, digest, JSON.stringify(input), `rev_${randomUUID()}`, `brn_${randomUUID()}`])).rows[0]!;
    });
    if (reserved.receipt !== null) return RevisionPreviewReceiptSchema.parse(reserved.receipt);
    if (!this.source || !this.content) throw unsupported();
    await this.gate.ensure(ctx, input.workspaceId);
    const source = await this.source(ctx, input.workspaceId); // outside every retried transaction
    return this.app.withTenant(ctx.accountId, async (q) => {
      await this.gate.lock(q, ctx, input.workspaceId);
      const held = (await this.held(q, ctx, input, digest))!;
      if (held.receipt !== null) return RevisionPreviewReceiptSchema.parse(held.receipt);
      let receipt: RevisionPreviewReceipt;
      const common = { workspaceId: input.workspaceId, requestId: input.requestId, adoptionAvailable: false as const };
      try {
        const snapshot = await archiveSnapshot(q, ctx, input.workspaceId);
        const display = (await q.query<{ version: string }>('SELECT version FROM content_metadata WHERE account_id = $1 AND workspace_id = $2 AND content_id = $3', [ctx.accountId, input.workspaceId, input.contentId])).rows[0];
        const lifecycle = snapshot.lifecycle.find((e) => e.contentId === input.contentId);
        const stream = (await q.query<{ event_seq: string; last_event_id: string | null; branch_manifest: unknown }>(
          'SELECT event_seq, last_event_id, branch_manifest FROM sync_streams WHERE account_id = $1 AND workspace_id = $2 AND stream_id = $3',
          [ctx.accountId, input.workspaceId, input.streamId])).rows[0];
        if (!display || !lifecycle || !stream) throw notFound('修订内容或分支不存在');
        const manifest = SyncBranchManifestSchema.safeParse(stream.branch_manifest);
        if (!manifest.success) throw new Rejected('history');
        if (Number(stream.event_seq) !== input.baseSeq || stream.last_event_id !== input.baseEventId
          || Number(display.version) !== input.displayVersion || lifecycle.version !== input.lifecycleVersion || snapshot.state.version !== input.archiveVersion
          || !manifest.data.adopted.some((a) => a.contentId === input.contentId && a.revisionId === input.baseRevisionId)) {
          receipt = { ...common, outcome: 'conflict', reason: 'precondition' };
        } else if (lifecycle.sourceKind !== 'generated' || lifecycle.value.lifecycle !== 'active'
          || snapshot.state.volumes.some((v) => (v as { members: { contentId: string }[] }).members.some((m) => m.contentId === input.contentId))) {
          throw new Rejected('members');
        } else {
          const inventory = await this.inventory(q, ctx, input, source);
          receipt = this.compile(input, held, inventory.workspace, {
            sourceDigest: sha(source), inventoryDigest: inventory.digest, streamId: input.streamId, baseRevisionId: input.baseRevisionId,
            eventCount: input.baseSeq, lastEventId: input.baseEventId, displayVersion: input.displayVersion,
            lifecycleVersion: input.lifecycleVersion, archiveVersion: input.archiveVersion,
          });
        }
      } catch (error) {
        if (!(error instanceof Rejected)) throw error;
        receipt = { ...common, outcome: 'rejected', reason: error.reason };
      }
      if (Buffer.byteLength(JSON.stringify(receipt)) > MAX_BYTES) receipt = { ...common, outcome: 'rejected', reason: 'capacity' };
      RevisionPreviewReceiptSchema.parse(receipt);
      await q.query('UPDATE revision_previews SET receipt = $3 WHERE account_id = $1 AND request_id = $2', [ctx.accountId, input.requestId, JSON.stringify(receipt)]);
      return receipt;
    });
  }

  private async inventory(q: Querier, ctx: AuthContext, input: RevisionPreviewRequest, source: Workspace) {
    if (source.revisions.length >= LIMIT.revisions || source.entries.length > LIMIT.entries) throw new Rejected('capacity');
    const streams = await q.query<{ stream_id: string; event_seq: string; last_event_id: string | null; branch_manifest: unknown }>(
      'SELECT stream_id, event_seq, last_event_id, branch_manifest FROM sync_streams WHERE account_id = $1 AND workspace_id = $2 ORDER BY stream_id FOR UPDATE', [ctx.accountId, input.workspaceId]);
    if (streams.rows.length > LIMIT.streams || streams.rows.reduce((sum, r) => sum + Number(r.event_seq), 0) > LIMIT.events) throw new Rejected('capacity');
    const branches: Branch[] = [];
    const identities: unknown[] = [];
    for (const stream of streams.rows) {
      const parsed = SyncBranchManifestSchema.safeParse(stream.branch_manifest);
      if (!parsed.success || parsed.data.streamId !== stream.stream_id) throw new Rejected('history');
      const manifest = parsed.data;
      for (const a of manifest.adopted) if (!source.revisions.some((r) => r.id === a.revisionId && r.contentId === a.contentId)) throw new Rejected('history');
      const events = await q.query<{ event_seq: string; event_id: string; body: unknown; digest: string; command: unknown; occurred_at: Date }>(
        `SELECT se.event_seq, e.event_id, e.body, e.digest, e.command, e.occurred_at FROM stream_events se
         JOIN event_objects e USING (account_id, workspace_id, event_id)
         WHERE se.account_id = $1 AND se.workspace_id = $2 AND se.stream_id = $3 ORDER BY se.event_seq`, [ctx.accountId, input.workspaceId, stream.stream_id]);
      if (events.rows.length !== Number(stream.event_seq) || (events.rows.at(-1)?.event_id ?? null) !== stream.last_event_id) throw new Rejected('history');
      const bodies = events.rows.map((row, i) => {
        const event = SyncPlayerEventSchema.safeParse(row.body);
        if (!event.success || Number(row.event_seq) !== i + 1 || sha(row.body) !== row.digest || event.data.at !== row.occurred_at.toISOString()) throw new Rejected('history');
        const body = event.data;
        const command = body.type === 'answer' ? { type: body.type, scene: body.scene, choice: body.choice }
          : body.type === 'advance' ? { type: body.type, scene: body.scene, skip: body.skip } : { type: body.type, scene: body.scene };
        const owner = manifest.adopted.find((a) => source.revisions.find((r) => r.id === a.revisionId)?.episodeId === body.episode);
        if (sha(row.command) !== sha(command) || !owner || (body.contentId === undefined) !== (body.revisionId === undefined)
          || (body.contentId !== undefined && (body.contentId !== owner.contentId || body.revisionId !== owner.revisionId))) throw new Rejected('history');
        return body;
      });
      const first = source.revisions.find((r) => r.id === manifest.adopted[0]?.revisionId);
      if (!first) throw new Rejected('history');
      branches.push({ id: manifest.streamId, label: manifest.label, parentBranchId: manifest.parentBranchId,
        forkAtEventCount: manifest.forkAtEventCount, createdAt: manifest.createdAt, adopted: manifest.adopted,
        session: { version: 1, catalog: manifest.catalog, events: bodies, current: first.episodeId, revision: 0, largeText: false } });
      identities.push({ manifest, head: { count: Number(stream.event_seq), lastEventId: stream.last_event_id },
        events: events.rows.map((e) => ({ seq: Number(e.event_seq), id: e.event_id, digest: e.digest })) });
    }
    const workspace = { ...source, activeBranchId: input.streamId, branches };
    try {
      checked(workspace);
      for (const branch of branches) {
        const runtime = bridge(this.content!, workspace, branch.id);
        replayEvents(libraryLoader(runtime.library), runtime.session.events);
      }
      // Compare every immutable generation-time prefix to its stored binding before using it as a task authority.
      for (const revision of source.revisions) if (revision.origin !== 'bundled') {
        const basisBranch = branches.find((b) => b.id === revision.basis.branchId);
        if (!basisBranch || revision.basis.eventCount > basisBranch.session.events.length) throw new Rejected('history');
        const runtime = bridge(this.content!, workspace, basisBranch.id);
        const prefix = { ...runtime.session, events: runtime.session.events.slice(0, revision.basis.eventCount) };
        if (this.content!.historyKey(prefix).hash !== revision.basis.eventHash) throw new Rejected('history');
        for (const event of basisBranch.session.events.slice(0, revision.basis.eventCount)) {
          const owner = revision.basis.adopted.find((a) => source.revisions.find((r) => r.id === a.revisionId)?.episodeId === event.episode);
          if (!owner || (event.revisionId !== undefined && (event.revisionId !== owner.revisionId || event.contentId !== owner.contentId))) throw new Rejected('history');
        }
      }
    } catch { throw new Rejected('history'); }
    return { workspace, digest: sha(identities) };
  }

  private compile(input: RevisionPreviewRequest, held: Reservation, workspace: Workspace,
    binding: Extract<RevisionPreviewReceipt, { outcome: 'ready' }>['artifact']['binding']): RevisionPreviewReceipt {
    const common = { workspaceId: input.workspaceId, requestId: input.requestId, adoptionAvailable: false as const };
    const entry = workspace.entries.find((e) => e.id === input.contentId)!;
    try {
      const at = held.authored_at;
      const preview = previewRevision(this.content!, workspace, entry, input.draft, at, held.revision_id);
      if (!preview.ok || !preview.revision) return { ...common, outcome: 'rejected', reason: 'content' };
      const candidate = adoptRevision(this.content!, workspace, entry, preview.revision, at, held.branch_id);
      if (candidate.workspace.branches.length > LIMIT.streams) throw new Rejected('capacity');
      // Validate the complete result, including later adopted episodes. It is still only a dry run.
      checked(candidate.workspace);
      for (const branch of candidate.workspace.branches) bridge(this.content!, candidate.workspace, branch.id);
      const branch = candidate.workspace.branches.find((b) => b.id === candidate.workspace.activeBranchId)!;
      const revision: ContentRevision = ContentRevisionSchema.parse(candidate.workspace.revisions.find((r) => r.id === held.revision_id));
      const manifest: SyncBranchManifest = SyncBranchManifestSchema.parse({ streamId: branch.id, label: branch.label,
        parentBranchId: branch.parentBranchId, forkAtEventCount: branch.forkAtEventCount, adopted: branch.adopted,
        catalog: branch.session.catalog, createdAt: branch.createdAt, commonStreamId: branch.parentBranchId,
        commonPrefixSeq: branch.forkAtEventCount ?? 0 });
      const artifact = { compiler: 'cloud-revision-preview/1' as const, mode: candidate.mode, binding,
        revision, revisionDigest: sha(revision), branch: manifest };
      return { ...common, outcome: 'ready', artifact: { ...artifact, digest: sha(artifact) } };
    } catch (error) {
      if (error instanceof Rejected) throw error;
      // Never persist compiler/provider bodies, prompts, or excerpts from the untrusted draft as an error.
      return { ...common, outcome: 'rejected', reason: 'content' };
    }
  }
}
