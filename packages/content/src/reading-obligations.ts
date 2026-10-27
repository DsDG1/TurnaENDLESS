import { stableStringify } from '@endless/esl';
import { episodeCompletion, getScenes } from '@endless/player';
import { bridge } from './workspace.js';
import type { Content } from './index.js';
import type { Workspace } from './application-contract.js';

/** Reconstruct automatic completion from native reading evidence, preserving explicit/imported waivers.
 * The selected completion time is an actual final advance event, independent of branch iteration order. */
export function deriveReadingObligations(content: Content, workspace: Workspace): Workspace['obligations'] {
  const completed = new Map<string, string>();
  for (const branch of workspace.branches) {
    const needed = workspace.obligations.filter((o) => !o.waivedAt && branch.adopted.some((a) => a.contentId === o.contentId && a.revisionId === o.revisionId));
    if (!needed.length) continue;
    const runtime = bridge(content, workspace, branch.id), view = content.stateContext(runtime.session, runtime.library).view;
    for (const o of needed) {
      const revision = workspace.revisions.find((r) => r.id === o.revisionId)!;
      const episode = runtime.library.episodes.find((e) => e.id === revision.episodeId);
      if (!episode || !episodeCompletion(view.episodes[episode.id], getScenes(episode).length).read) continue;
      const at = branch.session.events.findLast((e) => e.type === 'advance' && e.episode === episode.id)?.at;
      if (!at) throw new Error('完成阅读缺少真实推进事件，义务保持不变');
      const key = `${o.contentId}:${o.revisionId}`, previous = completed.get(key);
      if (!previous || at < previous) completed.set(key, at);
    }
  }
  return workspace.obligations.map((o) => ({ ...o, waivedAt: o.waivedAt ?? completed.get(`${o.contentId}:${o.revisionId}`) ?? null }));
}

/** A local automatic fulfilment is progress, not a change to an immutable registration.
 * Only native completed-reading evidence can justify a locally fulfilled pending obligation. */
export function assertReadingObligationProgress(content: Content, workspace: Workspace, baseline: Workspace['obligations']): void {
  const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);
  const proofs = new Map<string, boolean>();
  const read = (contentId: string, revisionId: string): boolean => {
    const key = `${contentId}:${revisionId}`, known = proofs.get(key);
    if (known !== undefined) return known;
    const completed = workspace.branches.some((branch) => {
      if (!branch.adopted.some((a) => a.contentId === contentId && a.revisionId === revisionId)) return false;
      const runtime = bridge(content, workspace, branch.id);
      const revision = workspace.revisions.find((r) => r.id === revisionId);
      const episode = runtime.library.episodes.find((e) => e.id === revision?.episodeId);
      if (!episode) return false;
      return episodeCompletion(content.stateContext(runtime.session, runtime.library).view.episodes[episode.id], getScenes(episode).length).read;
    });
    proofs.set(key, completed); return completed;
  };
  if (workspace.obligations.length !== baseline.length || workspace.obligations.some((actual, i) => {
    const original = baseline[i]!;
    if (!same({ ...actual, waivedAt: null }, { ...original, waivedAt: null })) return true;
    if (actual.waivedAt === original.waivedAt) return false;
    return actual.waivedAt === null || !read(actual.contentId, actual.revisionId);
  })) throw new Error('本机义务与原始登记或真实完成阅读不一致，完整历史保留');
}

/** Preserve an already validated device's original completion time; never resurrect a fulfilled task. */
export function retainReadingCompletionTimes(local: Workspace['obligations'], remote: Workspace['obligations']): Workspace['obligations'] {
  return remote.map((entry) => {
    const previous = local.find((o) => o.contentId === entry.contentId && o.revisionId === entry.revisionId && o.createdAt === entry.createdAt);
    if (!previous?.waivedAt) return entry;
    if (!entry.waivedAt) throw new Error('快照未能重放已经完成的阅读义务，原历史保留');
    return { ...entry, waivedAt: previous.waivedAt };
  });
}
