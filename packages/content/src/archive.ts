/**
 * 智能归档：多集成卷 + 程序化摘要。
 * 摘要是派生数据——原始正文与事件仍是事实依据；未读、跳过、仅生成的内容
 * 不得被描述为实际完成阅读。合并多卷时从结构化来源重建，避免摘要套摘要漂移。
 */
import { contentHash } from '@endless/esl';
import { episodeCompletion, getScenes, projectSession, type PlayerView } from '@endless/player';
import { newId, type ArchiveQuote, type ArchiveVolume, type Workspace } from './index.js';
import type { WorkspaceRuntime } from './workspace.js';

const uuid = () => globalThis.crypto.randomUUID();
const viewOf = (runtime: WorkspaceRuntime): PlayerView => projectSession(runtime.session, runtime.library);

export interface VolumeSuggestion {
  series: string;
  contentIds: string[];
  reason: string;
}

const statusOf = (workspace: Workspace, runtime: WorkspaceRuntime, view: PlayerView, contentId: string) => {
  const adopted = runtime.branch.adopted.find((a) => a.contentId === contentId);
  if (!adopted) return 'unread' as const;
  const revision = workspace.revisions.find((r) => r.id === adopted.revisionId)!;
  const episode = runtime.library.episodes.find((e) => e.id === revision.episodeId);
  if (!episode) return 'unread' as const;
  const progress = view.episodes[episode.id];
  // 跳过也会推进 cursor，所以「走到末尾」不等于「读完」——先看真实完成状态。
  const { read, skipped } = episodeCompletion(progress, getScenes(episode).length);
  if (read) return 'read' as const;
  if (skipped > 0) return 'skipped' as const;
  return 'unread' as const;
};

/** 按「同系列 + 剧情连续性 + 阅读状态」给出候选卷；进行中任务锁定的对象排除，保留最近两集在活跃区。 */
export function suggestVolumes(workspace: Workspace, runtime: WorkspaceRuntime): VolumeSuggestion[] {
  const locked = new Set(workspace.tickets
    .filter((t) => t.status === 'reserved' || t.status === 'submitted')
    .flatMap((t) => t.basis.adopted.map((a) => a.contentId)));
  const entries = new Map(workspace.entries.map((e) => [e.id, e]));
  const view = viewOf(runtime);
  const bySeries = new Map<string, string[]>();
  for (const adopted of runtime.branch.adopted) {
    const entry = entries.get(adopted.contentId);
    if (!entry || entry.lifecycle !== 'active' || entry.archiveVolumeId || locked.has(entry.id)) continue;
    bySeries.set(entry.series, [...(bySeries.get(entry.series) ?? []), entry.id]);
  }
  const suggestions: VolumeSuggestion[] = [];
  for (const [series, group] of bySeries) {
    const candidates = group.slice(0, Math.max(0, group.length - 2));
    const completed = candidates.filter((id) => statusOf(workspace, runtime, view, id) === 'read');
    while (completed.length >= 3) {
      const member = completed.splice(0, Math.min(5, completed.length));
      if (member.length < 3) break;
      suggestions.push({ series, contentIds: member, reason: `同系列 ${member.length} 集已读完，可成卷` });
    }
  }
  return suggestions;
}

/** 从成员集的真实已读正文提取短引用（未完成/跳过的内容不进入摘要）。 */
function collectQuotes(workspace: Workspace, runtime: WorkspaceRuntime, view: PlayerView, memberIds: Set<string>): ArchiveQuote[] {
  const quotes: ArchiveQuote[] = [];
  for (const adopted of runtime.branch.adopted) {
    if (!memberIds.has(adopted.contentId)) continue;
    const revision = workspace.revisions.find((r) => r.id === adopted.revisionId)!;
    const episode = runtime.library.episodes.find((e) => e.id === revision.episodeId);
    if (!episode) continue;
    const progress = view.episodes[episode.id];
    for (const node of episode.ast.nodes) {
      const sceneId = node.parent?.startsWith('s') ? (node.parent.includes('.')
        ? episode.ast.nodes.find((n) => n.id === node.parent)?.parent ?? node.parent : node.parent) : null;
      if (!sceneId || !progress?.scenes[sceneId]?.completed) continue;
      const text = node.type === 'panel' ? node.data.caption : node.data.text;
      if (typeof text === 'string' && text && quotes.length < 200) {
        quotes.push({ revisionId: revision.id, contentId: adopted.contentId, sceneId, path: `${node.type}/${node.id}`, text: text.slice(0, 300) });
      }
    }
  }
  return quotes;
}

/** 构建归档卷：结构化事实、真实选择与开放线索取自重放状态，不推断不存在的关系。 */
export function buildVolume(workspace: Workspace, runtime: WorkspaceRuntime, memberContentIds: string[], title?: string): ArchiveVolume {
  const view = viewOf(runtime);
  const members = memberContentIds.map((contentId, order) => {
    const adopted = runtime.branch.adopted.find((a) => a.contentId === contentId);
    if (!adopted) throw new Error('该分支未采用此内容');
    return { contentId, revisionId: adopted.revisionId, order };
  });
  const memberSet = new Set(memberContentIds);
  const memberEpisodes = new Set(members.map((m) => workspace.revisions.find((r) => r.id === m.revisionId)!.episodeId));
  const facts = view.world.currentFacts()
    .filter((fact) => memberEpisodes.has(fact.source_batch))
    .slice(0, 200)
    .map((fact) => ({ subject: fact.subject, predicate: fact.predicate, object: fact.object }));
  const contentByEpisode = new Map(members.map((m) => [
    workspace.revisions.find((r) => r.id === m.revisionId)!.episodeId, m.contentId,
  ]));
  const choices = view.world.userFacts()
    .filter((fact) => memberEpisodes.has(fact.batch))
    .slice(0, 500)
    .map((fact) => ({ contentId: contentByEpisode.get(fact.batch)!, sceneId: fact.batch, chosen: `${fact.predicate} ${fact.object}` }));
  const reading = members.map((member) => ({ contentId: member.contentId, status: statusOf(workspace, runtime, view, member.contentId) }));
  const first = workspace.entries.find((e) => e.id === members[0]!.contentId)!;
  const threads = view.world.openThreads()
    .filter((thread) => thread.owner_channel === first.series)
    .slice(0, 200)
    .map((thread) => ({ id: thread.id, title: thread.title, status: thread.status }));
  const readTitles = members.map((m) => workspace.entries.find((e) => e.id === m.contentId)!.display.title);
  const narrative = `本卷收录 ${readTitles.join('、')}，共 ${members.length} 集。` +
    (facts.length ? `已确认事实 ${facts.length} 条；` : '') +
    (choices.length ? `记录真实选择 ${choices.length} 次；` : '') +
    (threads.length ? `仍有 ${threads.length} 条开放线索。` : '线索均已收束。');
  return {
    id: newId('volume', uuid), title: title?.trim() || `${readTitles[0] ?? '归档'} 等 ${members.length} 集`,
    series: first.series, createdAt: new Date().toISOString(), members,
    derivedFrom: {
      branchId: runtime.branch.id, eventCount: runtime.session.events.length,
      eventHash: contentHash({ catalog: runtime.session.catalog, events: runtime.session.events }),
    },
    reading, facts, choices, threads, narrative,
    quotes: collectQuotes(workspace, runtime, view, memberSet),
    strategy: { kind: 'programmatic', version: 1, stale: false },
    checkpointId: null,
  };
}
