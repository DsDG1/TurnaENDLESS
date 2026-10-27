import { episodeCompletion, getScenes, transition, type Library, type PlayerCommand } from '@endless/player';
import type { Branch, ReadingObligation, WorkspaceGraphRevision } from './application-contract.js';
import type { Content } from './index.js';

/** Native gameplay shared by complete workspaces and the separate metadata reading view.
 * No storage, provider or simulator is involved. Each caller validates its own complete reference graph. */
export function applyReadingCommand(content: Content, branch: Branch, revisions: readonly WorkspaceGraphRevision[],
  obligations: ReadingObligation[], library: Library, command: PlayerCommand, at = new Date()): { branch: Branch; obligations: ReadingObligation[] } {
  const next = transition(branch.session, command, library, at.toISOString());
  if (next === branch.session) return { branch, obligations };
  const adopted = new Map(branch.adopted.map((a) => [revisions.find((r) => r.id === a.revisionId)?.episodeId, a]));
  const events = next.events.map((event, i) => {
    if (i < branch.session.events.length) return event;
    const owner = adopted.get(event.episode);
    return owner ? { ...event, contentId: owner.contentId, revisionId: owner.revisionId } : event;
  });
  let updated = obligations;
  if (obligations.some((o) => !o.waivedAt)) {
    const view = content.stateContext(next, library).view;
    updated = obligations.map((o) => {
      if (o.waivedAt) return o;
      const revision = revisions.find((r) => r.id === o.revisionId), episode = library.episodes.find((e) => e.id === revision?.episodeId);
      return episode && episodeCompletion(view.episodes[episode.id], getScenes(episode).length).read ? { ...o, waivedAt: at.toISOString() } : o;
    });
  }
  return { branch: { ...branch, session: { ...next, events } }, obligations: updated };
}
