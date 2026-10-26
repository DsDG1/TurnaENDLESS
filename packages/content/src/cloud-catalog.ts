/**
 * 云阅读用的内容目录。
 *
 * 打开目录、读取场景数、按引用查找已保存的叙述，都不编译未访问的生成集。
 * 重放只会在事件真正落到某一集时编译它，以及校验所必需的更早生成集。
 * 比它更晚、且没有事件的集保持未编译。
 */
import { contentHash } from '@endless/esl';
import {
  episodeCompletion, type Episode, type Library, type PlayerCommand, type PlayerSession, type PlayerView,
} from '@endless/player';
import type { ContentRevision, Workspace } from './application-contract.js';
import type { Content, SavedPlayer } from './index.js';
import type { WorkspaceRuntime } from './workspace.js';

export interface CloudCatalogEntry {
  episodeId: string;
  contentId: string;
  revisionId: string;
  title: string;
  subtitle: string;
  description: string;
  sceneCount: number;
  series: string;
  bundled: boolean;
}

export interface HistoricalSource {
  episodeId: string;
  sceneId: string;
  lines: string[];
  /** 整集真正读完才为真。未读的原文仍可查找，不能当成已学。 */
  read: boolean;
}

interface Adopted {
  entryId: string;
  revision: Workspace['revisions'][number];
}

export interface CloudCatalog {
  entries: CloudCatalogEntry[];
  /** 本次目录里实际编译过的生成集，按采用顺序。试播集不计入。 */
  compiledGenerated(): string[];
  sceneCount(episodeId: string): number;
  /** 按 `episodeId.sceneId` 取该集已保存的叙述行，不因此编译。 */
  lookupSource(reference: string, view?: PlayerView): HistoricalSource;
  /** 编译这一集。更晚的生成集不编译。 */
  loadEpisode(episodeId: string): Episode;
  /** 把事件、当前集和本次命令会碰到的集编译进库，供一次玩法命令使用。 */
  prepare(session: PlayerSession, command?: PlayerCommand): void;
  library(): Library;
  runtime(workspace: Workspace): WorkspaceRuntime;
}

export function openCloudCatalog(content: Content, workspace: Workspace): CloudCatalog {
  const branch = workspace.branches.find((item) => item.id === workspace.activeBranchId);
  if (!branch) throw new Error('分支不存在');
  const revisions = new Map(workspace.revisions.map((revision) => [revision.id, revision]));
  const entriesById = new Map(workspace.entries.map((entry) => [entry.id, entry]));
  const pilotById = new Map(content.pilot.episodes.map((episode) => [episode.id, episode]));
  const adopted: Adopted[] = branch.adopted.map((item) => {
    const revision = revisions.get(item.revisionId);
    if (!revision || revision.contentId !== item.contentId) throw new Error(`分支采用了不存在的修订 ${item.revisionId}`);
    return { entryId: item.contentId, revision };
  });
  const byEpisode = new Map(adopted.map((item) => [item.revision.episodeId, item]));
  const generatedCache = new Map<string, Episode>();
  let entities = content.pilot.entities;
  let predicates = content.pilot.predicates;

  const describe = (item: Adopted): CloudCatalogEntry => {
    const entry = entriesById.get(item.entryId);
    const bundled = item.revision.origin === 'bundled';
    return {
      episodeId: item.revision.episodeId,
      contentId: item.entryId,
      revisionId: item.revision.id,
      title: entry?.display.title || item.revision.title,
      subtitle: entry?.display.subtitle || item.revision.subtitle,
      description: entry?.display.description || item.revision.description,
      sceneCount: bundled
        ? sceneCountOf(pilotById.get(item.revision.episodeId))
        : (item.revision as ContentRevision).batch.scenes.length,
      series: entry?.series ?? 'duck_detective',
      bundled,
    };
  };
  const entries = adopted.map(describe);

  function sceneCountOf(episode: Episode | undefined): number {
    if (!episode) throw new Error('试播内容不在目录中');
    return episode.ast.nodes.filter((node) => node.parent === episode.ast.batch).length;
  }

  function isGenerated(item: Adopted): item is Adopted & { revision: ContentRevision } {
    return item.revision.origin !== 'bundled';
  }

  function compileThrough(episodeId: string): void {
    const target = adopted.findIndex((item) => item.revision.episodeId === episodeId);
    if (target < 0) throw new Error(`内容不存在：${episodeId}`);
    const through = adopted.slice(0, target + 1);
    const allowed = new Set(through.map((item) => item.revision.episodeId));
    const generated = through.filter(isGenerated);
    if (!generated.length) return;
    const session: PlayerSession = {
      ...branch!.session,
      current: allowed.has(branch!.session.current) ? branch!.session.current : episodeId,
      // 更晚的集发生在这段前缀之后。去掉它们不会改变更早文档的依据哈希。
      events: branch!.session.events.filter((event) => allowed.has(event.episode)),
    };
    const restored = content.restore({
      version: 2,
      revision: session.revision,
      session,
      generated: generated.map((item) => toDocument(item.revision)),
    } satisfies SavedPlayer);
    entities = restored.library.entities;
    predicates = restored.library.predicates;
    for (const episode of restored.library.episodes) {
      if (!pilotById.has(episode.id)) generatedCache.set(episode.id, episode);
    }
  }

  function loadEpisode(episodeId: string): Episode {
    const pilot = pilotById.get(episodeId);
    if (pilot) {
      if (!byEpisode.has(episodeId)) throw new Error(`内容不存在：${episodeId}`);
      return pilot;
    }
    const cached = generatedCache.get(episodeId);
    if (cached) return cached;
    compileThrough(episodeId);
    const episode = generatedCache.get(episodeId);
    if (!episode) throw new Error(`内容不存在：${episodeId}`);
    return episode;
  }

  function library(): Library {
    const episodes: Episode[] = [];
    for (const item of adopted) {
      const id = item.revision.episodeId;
      if (item.revision.origin === 'bundled') {
        const episode = pilotById.get(id);
        if (episode) episodes.push(episode);
      } else {
        const episode = generatedCache.get(id);
        if (episode) episodes.push(episode);
      }
    }
    return {
      version: content.pilot.version,
      episodes,
      glossary: content.pilot.glossary,
      entities,
      predicates,
    };
  }

  return {
    entries,
    compiledGenerated: () => adopted
      .map((item) => item.revision.episodeId)
      .filter((id) => generatedCache.has(id)),
    sceneCount(episodeId: string) {
      const entry = entries.find((item) => item.episodeId === episodeId);
      if (!entry) throw new Error(`内容不存在：${episodeId}`);
      return entry.sceneCount;
    },
    lookupSource(reference: string, view?: PlayerView): HistoricalSource {
      const dot = reference.lastIndexOf('.');
      if (dot <= 0 || dot === reference.length - 1) throw new Error('来源引用需要写成「集.场景」');
      const episodeId = reference.slice(0, dot);
      const sceneId = reference.slice(dot + 1);
      const item = byEpisode.get(episodeId);
      if (!item) throw new Error(`内容不存在：${episodeId}`);
      const lines = item.revision.origin === 'bundled'
        ? linesFromAst(pilotById.get(episodeId), sceneId)
        : linesFromBatch(item.revision as ContentRevision, sceneId);
      if (!lines.length) throw new Error(`场景 ${sceneId} 没有可引用的叙述`);
      const progress = view?.episodes[episodeId];
      const sceneCount = entries.find((entry) => entry.episodeId === episodeId)!.sceneCount;
      return { episodeId, sceneId, lines, read: episodeCompletion(progress, sceneCount).read };
    },
    loadEpisode,
    prepare(session: PlayerSession, command?: PlayerCommand) {
      const ids = new Set<string>([session.current]);
      for (const event of session.events) ids.add(event.episode);
      if (command?.type === 'select') ids.add(command.episode);
      for (const id of ids) loadEpisode(id);
    },
    library,
    runtime(current: Workspace): WorkspaceRuntime {
      const active = current.branches.find((item) => item.id === current.activeBranchId);
      if (!active) throw new Error('分支不存在');
      const owners = new Map<string, { entry: Workspace['entries'][number]; revision: Workspace['revisions'][number] }>();
      for (const item of active.adopted) {
        const revision = current.revisions.find((row) => row.id === item.revisionId);
        const entry = current.entries.find((row) => row.id === item.contentId);
        if (!revision || !entry) throw new Error(`分支采用了不存在的修订 ${item.revisionId}`);
        owners.set(revision.episodeId, { entry, revision });
      }
      const generated = active.adopted.flatMap((item) => {
        const revision = current.revisions.find((row) => row.id === item.revisionId);
        return revision && revision.origin !== 'bundled' ? [toDocument(revision)] : [];
      });
      return {
        session: active.session,
        library: library(),
        owners,
        save: { version: 2, revision: active.session.revision, session: active.session, generated },
        branch: active,
      };
    },
  };
}

function toDocument(revision: ContentRevision): SavedPlayer['generated'][number] {
  return {
    version: 1,
    generatedAt: revision.plannedAt,
    basedOn: { eventCount: revision.basis.eventCount, hash: revision.basis.eventHash },
    title: revision.title,
    subtitle: revision.subtitle,
    description: revision.description,
    batch: revision.batch,
    hash: revision.hash,
    learningVersion: 4,
    creation: revision.creation,
  };
}

function linesFromBatch(revision: ContentRevision, sceneId: string): string[] {
  if (contentHash(revision.batch) !== revision.hash) throw new Error('AI 内容哈希不匹配，原始存档已保留');
  const scene = revision.batch.scenes.find((item) => item.id === sceneId);
  if (!scene) return [];
  return narrativeLines(scene);
}

function linesFromAst(episode: Episode | undefined, sceneId: string): string[] {
  if (!episode) return [];
  const lines: string[] = [];
  for (const node of episode.ast.nodes) {
    if ((node.type === 'bubble' || node.type === 'message') && typeof node.data.text === 'string' && node.data.text) {
      const parent = typeof node.parent === 'string' ? node.parent : '';
      const scene = parent.startsWith(`${sceneId}.`) || parent === sceneId
        ? sceneId
        : episode.ast.nodes.find((item) => item.id === parent)?.parent;
      if (scene === sceneId) lines.push(node.data.text);
    } else if (node.type === 'panel' && node.parent === sceneId && typeof node.data.caption === 'string' && node.data.caption) {
      lines.push(node.data.caption);
    }
  }
  return lines;
}

function narrativeLines(scene: { type: string; panels?: readonly { caption?: string; bubbles?: readonly { text?: string }[] }[]; messages?: readonly { text?: string }[] }): string[] {
  if (scene.type === 'comic') {
    const lines: string[] = [];
    for (const panel of scene.panels ?? []) {
      if (panel.caption) lines.push(panel.caption);
      for (const bubble of panel.bubbles ?? []) if (bubble.text) lines.push(bubble.text);
    }
    return lines;
  }
  if (scene.type === 'chat') return (scene.messages ?? []).flatMap((message) => message.text ? [message.text] : []);
  return [];
}
