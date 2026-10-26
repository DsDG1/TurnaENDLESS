/**
 * 已验证的学习上下文。
 *
 * 本机存档和云端历史都先重放，再把同一个计划时间交给现有的 planCreative。
 * 云端排队、重启或跨过复习到期点时，不能改用 Worker 当时的 new Date()。
 */
import { projectSession, type Library, type PlayerEvent, type PlayerSession } from '@endless/player';
import type { Content } from './index.js';

export interface VerifiedPrefix {
  source: 'local-saved-player' | 'cloud-history';
  session: PlayerSession;
  library: Library;
  /** 重建学习任务的时间。旧文档里它仍写在 generatedAt。 */
  plannedAt: string;
  completePrefix: true;
}

export function localVerifiedPrefix(session: PlayerSession, library: Library, plannedAt: string): VerifiedPrefix {
  projectSession(session, library);
  return { source: 'local-saved-player', session, library, plannedAt, completePrefix: true };
}

export function cloudVerifiedPrefix(input: {
  events: readonly PlayerEvent[];
  catalog: string;
  current: string;
  library: Library;
  plannedAt: string;
  completePrefix: boolean;
}): VerifiedPrefix {
  if (input.completePrefix !== true) throw new Error('云端学习上下文不能使用被截断的历史前缀');
  if (input.library.version !== input.catalog) throw new Error('云端学习上下文的目录版本与历史不一致');
  if (!input.library.episodes.some((episode) => episode.id === input.current)) {
    throw new Error('云端学习上下文的当前位置不在目录中');
  }
  const session: PlayerSession = {
    version: 1, catalog: input.catalog, revision: input.events.length,
    current: input.current, largeText: false, events: [...input.events],
  };
  projectSession(session, input.library);
  return {
    source: 'cloud-history', session, library: input.library,
    plannedAt: input.plannedAt, completePrefix: true,
  };
}

export function planAtFrozenTime(content: Content, prefix: VerifiedPrefix) {
  return content.planCreative(prefix.session, prefix.library, new Date(prefix.plannedAt));
}

/** 旧校验信封的 generatedAt 保持「用于重建学习计划的时间」。真实落稿时间另存，不改已有文档。 */
export function legacyEnvelopeGeneratedAt(plannedAt: string): string {
  return plannedAt;
}
