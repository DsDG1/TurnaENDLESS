import { stableStringify } from '@endless/esl';
import { ReadingSnapshotSchema, type ReadingSnapshot, type SyncStreamHistory } from '@endless/cloud-contracts';
import { applyPlayerCommand, bridge, checked, switchBranch } from './workspace.js';
import { parseWorkspace } from './application-contract.js';
import { adoptRevision, previewRevision } from './revision.js';
import { ContentRevisionSchema, type Content, type Workspace } from './index.js';

const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);
const fail = (): never => { throw new Error('阅读快照的内容、前缀或原生重放不一致，完整本机数据保留'); };
type Digest = (value: unknown) => Promise<string>;

/** Rebuild from the receipt-bound import, immutable event inventory and native revision rules.
 * No client storage, clocks, generated identities or network operations participate in validation. */
export async function rebuildCloudReading(content: Content, raw: ReadingSnapshot, digest: Digest): Promise<Workspace> {
  const snapshot = ReadingSnapshotSchema.parse(raw), { digest: hash, ...body } = snapshot;
  const seed = parseWorkspace(snapshot.source);
  const catalog = snapshot.revisionCatalog;
  if (await digest(body) !== hash || await digest(seed) !== snapshot.sourceDigest
    || catalog.workspaceId !== snapshot.workspaceId || catalog.version !== catalog.registrations.length
    || await digest(catalog.registrations) !== catalog.digest
    || seed.entries.length > 500 || seed.revisions.length + catalog.version > 64
    || snapshot.histories.reduce((n, h) => n + h.events.length, 0) > 10_000) fail();
  const histories = new Map(snapshot.histories.map((h) => [h.stream.streamId, h]));
  if (histories.size !== snapshot.histories.length) fail();
  const ids = new Map<string, unknown>();
  for (const h of histories.values()) {
    if (h.stream.streamId !== h.stream.branchId || h.branch.streamId !== h.stream.streamId
      || h.events.length !== h.stream.eventSeq || (h.events.at(-1)?.eventId ?? null) !== h.stream.lastEventId
      || new Set(h.events.map((e) => e.eventId)).size !== h.events.length) fail();
    for (const [i, e] of h.events.entries()) {
      const command = e.event.type === 'answer' ? { type: e.event.type, scene: e.event.scene, choice: e.event.choice }
        : e.event.type === 'advance' ? { type: e.event.type, scene: e.event.scene, skip: e.event.skip } : { type: e.event.type, scene: e.event.scene };
      if (e.seq !== i + 1 || e.at !== e.event.at || await digest(e.event) !== e.digest || !same(e.command, command)) fail();
      const old = ids.get(e.eventId);
      if (old && !same(old, { event: e.event, command: e.command, at: e.at, digest: e.digest })) fail();
      ids.set(e.eventId, { event: e.event, command: e.command, at: e.at, digest: e.digest });
    }
  }
  for (const b of seed.branches) {
    const h = histories.get(b.id);
    if (!h || b.session.events.some((e, i) => !same(e, h.events[i]?.event))) fail();
  }
  for (const [i, r] of catalog.registrations.entries()) {
    const { digest: artifactHash, ...artifact } = r.artifact;
    if (r.version !== i + 1 || r.readingChangeSeq > snapshot.changeSeq
      || (i > 0 && r.readingChangeSeq < catalog.registrations[i - 1]!.readingChangeSeq)
      || await digest(artifact) !== artifactHash || await digest(r.artifact.revision) !== r.artifact.revisionDigest) fail();
  }
  let workspace = seed;
  let generationSource = seed;
  const visiting = new Set<string>();
  const history = (id: string): SyncStreamHistory => histories.get(id) ?? fail();
  const eventsTo = (id: string, count: number, version: number) => {
    ensure(id, version);
    const h = history(id), branch = workspace.branches.find((b) => b.id === id)!;
    if (count > h.events.length || count < branch.session.events.length) fail();
    for (const e of h.events.slice(branch.session.events.length, count)) {
      workspace = applyPlayerCommand(content, switchBranch(workspace, id), { type: 'select', episode: e.event.episode }, new Date(e.at));
      workspace = applyPlayerCommand(content, workspace, e.command, new Date(e.at));
      if (!same(workspace.branches.find((b) => b.id === id)!.session.events.at(-1), e.event)) fail();
    }
  };
  const ensure = (id: string, version: number): void => {
    if (workspace.branches.some((b) => b.id === id)) return;
    if (visiting.has(id)) fail();
    visiting.add(id);
    const h = history(id), m = h.branch;
    // A revision fork must be created by native adoption, never by trusting a final manifest.
    if (catalog.registrations.some((r) => r.version >= version && r.artifact.mode === 'fork' && r.stream.streamId === id)) fail();
    if (!m.commonStreamId) fail();
    ensure(m.commonStreamId!, version);
    let parent = workspace.branches.find((b) => b.id === m.commonStreamId)!;
    if (parent.session.events.length < m.commonPrefixSeq) eventsTo(parent.id, m.commonPrefixSeq, version);
    parent = workspace.branches.find((b) => b.id === m.commonStreamId)!;
    let adopted = m.adopted;
    // Undo future in-place replacements to recover the catalogue at this validation boundary.
    for (const r of [...catalog.registrations].reverse()) if (r.version >= version) {
      const revision = ContentRevisionSchema.parse(r.artifact.revision);
      adopted = adopted.map((a) => a.revisionId === revision.id ? { ...a, revisionId: r.artifact.binding.baseRevisionId } : a);
    }
    if (m.commonPrefixSeq > h.events.length || !same(parent.session.events.slice(0, m.commonPrefixSeq), h.events.slice(0, m.commonPrefixSeq).map((e) => e.event))) fail();
    const p = history(parent.id);
    for (let i = 0; i < m.commonPrefixSeq; i++) if (p.events[i]?.eventId !== h.events[i]?.eventId) fail();
    const first = workspace.revisions.find((r) => r.id === adopted[0]?.revisionId) ?? fail();
    workspace = checked({ ...workspace, branches: [...workspace.branches, {
      id: m.streamId, label: m.label, parentBranchId: m.parentBranchId, forkAtEventCount: m.forkAtEventCount,
      createdAt: m.createdAt, adopted,
      session: { version: 1, catalog: m.catalog, events: h.events.slice(0, m.commonPrefixSeq).map((e) => e.event),
        current: first.episodeId, largeText: false, revision: 0 },
    }] });
    visiting.delete(id);
  };
  for (const r of catalog.registrations) {
    const a = r.artifact, binding = a.binding, revision = ContentRevisionSchema.parse(a.revision);
    if (await digest(generationSource) !== binding.sourceDigest) fail();
    eventsTo(binding.streamId, binding.eventCount, r.version);
    if ((history(binding.streamId).events[binding.eventCount - 1]?.eventId ?? null) !== binding.lastEventId) fail();
    const entry = workspace.entries.find((e) => e.id === revision.contentId) ?? fail();
    workspace = switchBranch(workspace, binding.streamId);
    const preview = previewRevision(content, workspace, entry, revision.draft, new Date(revision.authoredAt), revision.id);
    if (!preview.ok || !same(preview.revision, revision) || revision.parentRevisionId !== binding.baseRevisionId) fail();
    const candidate = adoptRevision(content, workspace, entry, revision, new Date(revision.authoredAt), a.branch.streamId);
    workspace = candidate.workspace;
    const b = workspace.branches.find((b) => b.id === workspace.activeBranchId)!;
    const manifest = { streamId: b.id, label: b.label, parentBranchId: b.parentBranchId, forkAtEventCount: b.forkAtEventCount,
      adopted: b.adopted, createdAt: b.createdAt, catalog: b.session.catalog, commonStreamId: b.parentBranchId, commonPrefixSeq: b.forkAtEventCount ?? 0 };
    const e = workspace.entries.find((e) => e.id === revision.contentId)!;
    const count = a.mode === 'fork' ? a.branch.commonPrefixSeq : binding.eventCount;
    if (candidate.mode !== a.mode || !same(manifest, a.branch) || !same(workspace.obligations, r.obligations)
      || !same(r.entry, { contentId: e.id, revisionIds: e.revisionIds, headRevisionId: e.headRevisionId, updatedAt: e.updatedAt })
      || r.display.contentId !== e.id || r.display.version !== binding.displayVersion + 1 || r.display.value.title !== e.display.title
      || r.stream.streamId !== b.id || r.stream.branchId !== b.id || r.stream.eventSeq !== count
      || (history(b.id).events[count - 1]?.eventId ?? null) !== r.stream.lastEventId) fail();
    if (a.mode === 'fork') {
      const prefix = history(binding.streamId).events.slice(0, count).map((e) => e.eventId);
      if (!r.prefixEventIds || !same(r.prefixEventIds, prefix) || !same(history(b.id).events.slice(0, count).map((e) => e.eventId), prefix)) fail();
    }
    generationSource = { ...generationSource, revisions: [...generationSource.revisions, revision], obligations: r.obligations,
      entries: generationSource.entries.map((e) => e.id === revision.contentId ? { ...e, revisionIds: r.entry.revisionIds,
        headRevisionId: revision.id, updatedAt: r.entry.updatedAt } : e) };
  }
  for (const h of histories.values()) eventsTo(h.stream.streamId, h.events.length, catalog.version + 1);
  for (const h of histories.values()) {
    const b = workspace.branches.find((b) => b.id === h.stream.streamId)!;
    if (!same(b.adopted, h.branch.adopted) || b.label !== h.branch.label || b.createdAt !== h.branch.createdAt
      || b.parentBranchId !== h.branch.parentBranchId || b.forkAtEventCount !== h.branch.forkAtEventCount || b.session.catalog !== h.branch.catalog) fail();
    bridge(content, workspace, b.id);
  }
  // Reprove every immutable generation boundary against the reconstructed original history.
  for (const r of workspace.revisions) if (r.origin !== 'bundled') {
    const b = workspace.branches.find((b) => b.id === r.basis.branchId) ?? fail();
    const runtime = bridge(content, workspace, b.id);
    if (b.session.events.length < r.basis.eventCount
      || content.historyKey({ ...runtime.session, events: runtime.session.events.slice(0, r.basis.eventCount) }).hash !== r.basis.eventHash) fail();
  }
  return checked(workspace);
}
