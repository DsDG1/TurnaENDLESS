import { createHash, randomUUID } from 'node:crypto';
import { stableStringify } from '@endless/esl';
import {
  adoptRevision, bridge, checked, ContentRevisionSchema, deriveReadingObligations, previewRevision,
  type Branch, type Content, type ContentRevision, type Workspace,
} from '@endless/content';
import { libraryLoader, replayEvents } from '@endless/player';
import {
  CLOUD_LIMITS, RevisionPreviewRequestSchema, RevisionPreviewReceiptSchema,
  SyncBranchManifestSchema, SyncPlayerEventSchema,
  type RevisionPreviewRequest, type RevisionPreviewReceipt, type SyncBranchManifest,
  RevisionAdoptionCommandSchema, RevisionAdoptionReceiptSchema, RevisionRegistrationSchema, MetadataEntrySchema,
  type RevisionAdoptionCommand, type RevisionAdoptionReceipt, type RevisionRegistration,
} from '@endless/cloud-contracts';
import type { AuthContext } from '../auth/service.js';
import type { CloudPool, Querier } from '../db/client.js';
import { CloudError, badRequest, idempotencyMismatch, notFound } from '../errors.js';
import { archiveSnapshot } from './archives.js';
import { recordManagement } from './management-feed.js';
import { boundRevisionCatalog, revisionCatalog, withRegisteredRevisions } from './revision-registry.js';

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
      const common = { workspaceId: input.workspaceId, requestId: input.requestId, adoptionAvailable: false as const };
      let receipt = await this.evaluate(q, ctx, input, held, source);
      if (Buffer.byteLength(JSON.stringify(receipt)) > MAX_BYTES) receipt = { ...common, outcome: 'rejected', reason: 'capacity' };
      RevisionPreviewReceiptSchema.parse(receipt);
      await q.query('UPDATE revision_previews SET receipt = $3 WHERE account_id = $1 AND request_id = $2', [ctx.accountId, input.requestId, JSON.stringify(receipt)]);
      return receipt;
    });
  }

  async catalog(ctx: AuthContext, workspaceId: string) {
    return this.app.withTenant(ctx.accountId, async (q) => {
      await this.gate.lock(q, ctx, workspaceId);
      return revisionCatalog(q, ctx, workspaceId);
    });
  }

  private async adoptionHeld(q: Querier, ctx: AuthContext, input: RevisionAdoptionCommand, digest: string) {
    const row = (await q.query<{ request_digest: string; receipt: unknown }>(
      'SELECT request_digest, receipt FROM metadata_commands WHERE account_id = $1 AND command_id = $2', [ctx.accountId, input.commandId])).rows[0];
    if (!row) return null;
    if (row.request_digest !== digest) throw idempotencyMismatch();
    return RevisionAdoptionReceiptSchema.parse(row.receipt);
  }

  private async confirmedPreview(q: Querier, ctx: AuthContext, input: RevisionAdoptionCommand) {
    const row = (await q.query<Reservation & { request: unknown }>(
      'SELECT * FROM revision_previews WHERE account_id = $1 AND workspace_id = $2 AND request_id = $3',
      [ctx.accountId, input.workspaceId, input.previewRequestId])).rows[0];
    if (!row) throw notFound('修订预览不存在');
    const preview = RevisionPreviewReceiptSchema.safeParse(row.receipt);
    if (!preview.success || preview.data.outcome !== 'ready' || preview.data.artifact.digest !== input.artifactDigest) throw badRequest('确认必须绑定已完成预览的摘要');
    const request = RevisionPreviewRequestSchema.parse(row.request);
    if (request.workspaceId !== input.workspaceId || request.requestId !== input.previewRequestId || sha(request) !== row.request_digest) throw unsupported();
    return { row, request, artifact: preview.data.artifact };
  }

  /** Explicit confirmation revalidates the immutable preview under the same locks as event pushes. */
  async adopt(ctx: AuthContext, raw: RevisionAdoptionCommand): Promise<RevisionAdoptionReceipt> {
    const input = RevisionAdoptionCommandSchema.parse(raw), digest = sha(input);
    const saved = await this.app.withTenant(ctx.accountId, async (q) => {
      await this.gate.lock(q, ctx, input.workspaceId);
      const receipt = await this.adoptionHeld(q, ctx, input, digest);
      if (!receipt) await this.confirmedPreview(q, ctx, input);
      return receipt;
    });
    if (saved) return saved;
    if (!this.source || !this.content) throw unsupported();
    await this.gate.ensure(ctx, input.workspaceId);
    const source = await this.source(ctx, input.workspaceId); // never inside the retried transaction
    return this.app.withTenant(ctx.accountId, async (q) => {
      await this.gate.lock(q, ctx, input.workspaceId);
      const duplicate = await this.adoptionHeld(q, ctx, input, digest); if (duplicate) return duplicate;
      const preview = await this.confirmedPreview(q, ctx, input);
      const common = { workspaceId: input.workspaceId, commandId: input.commandId };
      let receipt: RevisionAdoptionReceipt;
      let candidate: Workspace | undefined;
      let registration: RevisionRegistration | undefined;
      const catalog = await revisionCatalog(q, ctx, input.workspaceId);
      // A different confirmation of the same preview is a stale action, not a second installation.
      if (catalog.registrations.some((r) => r.previewRequestId === input.previewRequestId)) {
        receipt = { ...common, outcome: 'conflict', reason: 'precondition' };
      } else {
        const current = await this.evaluate(q, ctx, preview.request, preview.row, source);
        if (current.outcome === 'conflict') receipt = { ...common, outcome: 'conflict', reason: current.reason };
        else if (current.outcome === 'rejected') receipt = { ...common, outcome: 'rejected', reason: current.reason };
        else if (current.artifact.digest !== input.artifactDigest) receipt = { ...common, outcome: 'conflict', reason: 'precondition' };
        else {
          const expanded = withRegisteredRevisions(source, catalog);
          const inventory = await this.inventory(q, ctx, preview.request, expanded);
          const revision = ContentRevisionSchema.parse(current.artifact.revision);
          candidate = adoptRevision(this.content!, inventory.workspace, inventory.workspace.entries.find((e) => e.id === revision.contentId)!,
            revision, preview.row.authored_at, preview.row.branch_id).workspace;
          const entry = candidate.entries.find((e) => e.id === revision.contentId)!;
          const displayRow = (await q.query<{ version: string; value: Record<string, unknown> }>(
            'SELECT version, value FROM content_metadata WHERE account_id = $1 AND workspace_id = $2 AND content_id = $3',
            [ctx.accountId, input.workspaceId, revision.contentId])).rows[0]!;
          const display = MetadataEntrySchema.parse({ contentId: revision.contentId, version: Number(displayRow.version) + 1,
            value: { ...displayRow.value, title: revision.title }, updatedAt: preview.row.authored_at.toISOString() });
          const count = current.artifact.mode === 'fork' ? current.artifact.branch.commonPrefixSeq : preview.request.baseSeq;
          const last = count ? (await q.query<{ event_id: string }>(
            'SELECT event_id FROM stream_events WHERE account_id = $1 AND workspace_id = $2 AND stream_id = $3 AND event_seq = $4',
            [ctx.accountId, input.workspaceId, preview.request.streamId, count])).rows[0]?.event_id : null;
          if (count && !last) throw unsupported();
          const readingHead = (await q.query<{ change_seq: string }>(
            'SELECT change_seq FROM workspace_change_heads WHERE account_id = $1 AND workspace_id = $2', [ctx.accountId, input.workspaceId])).rows[0];
          const prefixEventIds = current.artifact.mode === 'fork' ? (await q.query<{ event_id: string }>(
            'SELECT event_id FROM stream_events WHERE account_id = $1 AND workspace_id = $2 AND stream_id = $3 AND event_seq <= $4 ORDER BY event_seq',
            [ctx.accountId, input.workspaceId, preview.request.streamId, count])).rows.map((r) => r.event_id) : [];
          registration = RevisionRegistrationSchema.parse({ format: 'cloud-revision-registration/1', version: catalog.version + 1,
            readingChangeSeq: Number(readingHead?.change_seq ?? 0),
            readingContext: { format: 'cloud-revision-reading-context/1', heads: inventory.heads },
            prefixEventIds,
            commandId: input.commandId, previewRequestId: input.previewRequestId, artifact: current.artifact,
            entry: { contentId: entry.id, revisionIds: entry.revisionIds, headRevisionId: entry.headRevisionId, updatedAt: entry.updatedAt },
            obligations: candidate.obligations, display,
            stream: { streamId: current.artifact.branch.streamId, branchId: current.artifact.branch.streamId, eventSeq: count, lastEventId: last },
          });
          try { boundRevisionCatalog({ workspaceId: input.workspaceId, version: registration.version,
            registrations: [...catalog.registrations, registration], digest: sha([...catalog.registrations, registration]) }); }
          catch { registration = undefined; }
          receipt = registration ? { ...common, outcome: 'applied', registration } : { ...common, outcome: 'rejected', reason: 'capacity' };
        }
      }
      RevisionAdoptionReceiptSchema.parse(receipt);
      await q.query(`INSERT INTO metadata_commands (account_id, workspace_id, command_id, device_id, request_digest, request, receipt)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`, [ctx.accountId, input.workspaceId, input.commandId, ctx.deviceId, digest, JSON.stringify(input), JSON.stringify(receipt)]);
      if (receipt.outcome === 'applied' && registration && candidate) {
        const { artifact, stream, display } = registration;
        const revision = ContentRevisionSchema.parse(artifact.revision);
        if (artifact.mode === 'fork') {
          // Create the empty stream first (membership has a stream FK), then share existing prefix identities.
          await q.query(`INSERT INTO sync_streams (account_id, workspace_id, stream_id, branch_id, parent_stream_id, fork_at_seq, branch_manifest)
            VALUES ($1, $2, $3, $3, $4, $5, $6)`,
          [ctx.accountId, input.workspaceId, stream.streamId, preview.request.streamId, stream.eventSeq, JSON.stringify(artifact.branch)]);
          await q.query(`INSERT INTO stream_events (account_id, workspace_id, stream_id, event_seq, event_id)
            SELECT account_id, workspace_id, $4, event_seq, event_id FROM stream_events
            WHERE account_id = $1 AND workspace_id = $2 AND stream_id = $3 AND event_seq <= $5`,
          [ctx.accountId, input.workspaceId, preview.request.streamId, stream.streamId, stream.eventSeq]);
        }
        await q.query(`UPDATE sync_streams SET event_seq = $4, last_event_id = $5, branch_manifest = $6, updated_at = now()
          WHERE account_id = $1 AND workspace_id = $2 AND stream_id = $3`,
        [ctx.accountId, input.workspaceId, stream.streamId, stream.eventSeq, stream.lastEventId, JSON.stringify(artifact.branch)]);
        await q.query(`UPDATE content_metadata SET version = $4, value = $5, updated_at = $6
          WHERE account_id = $1 AND workspace_id = $2 AND content_id = $3`,
        [ctx.accountId, input.workspaceId, display.contentId, display.version, JSON.stringify(display.value), display.updatedAt]);
        await q.query(`INSERT INTO revision_registrations (account_id, workspace_id, version, command_id, preview_request_id, content_id, revision_id, digest, body)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [ctx.accountId, input.workspaceId, registration.version, input.commandId, input.previewRequestId, revision.contentId, revision.id, sha(registration), JSON.stringify(registration)]);
        await q.query('UPDATE workspaces SET cloud_version = cloud_version + 1 WHERE account_id = $1 AND id = $2', [ctx.accountId, input.workspaceId]);
        await recordManagement(q, ctx.accountId, input.workspaceId, input.commandId, { type: 'revision', registration });
      }
      return receipt;
    });
  }

  private async evaluate(q: Querier, ctx: AuthContext, input: RevisionPreviewRequest, held: Reservation, original: Workspace): Promise<RevisionPreviewReceipt> {
    const source = withRegisteredRevisions(original, await revisionCatalog(q, ctx, input.workspaceId));
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
    return receipt;
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
    return { workspace: { ...workspace, obligations: deriveReadingObligations(this.content!, workspace) }, digest: sha(identities),
      heads: streams.rows.map((s) => ({ streamId: s.stream_id, branchId: s.stream_id, eventSeq: Number(s.event_seq), lastEventId: s.last_event_id })) };
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
      if (candidate.workspace.branches.length > LIMIT.streams
        || candidate.workspace.branches.reduce((sum, b) => sum + b.session.events.length, 0) > LIMIT.events) throw new Rejected('capacity');
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
