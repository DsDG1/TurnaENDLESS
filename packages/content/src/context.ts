/**
 * 生成上下文构建器：把当前工作区压缩成一次生成所需的输入。
 * 优先级：正确性约束（学习任务、素材）> 必要事实与来源 > 相关近期内容 > 较远叙事细节。
 * 已归档的内容用结构化摘要代替逐场原文；未读/跳过内容不进入「已经历」部分。
 */
import type { ArchiveVolume, SavedPlayer, Workspace } from './index.js';
import { bridgeSave, type WorkspaceRuntime } from './workspace.js';

/** 提交给本机生成接口的归档上下文（随 save 一起，经 schema 校验）。 */
export interface ArchiveContextEntry {
  volumeId: string;
  series: string;
  title: string;
  narrative: string;
  facts: { subject: string; predicate: string; object: string }[];
  choices: { chosen: string }[];
  threads: { id: string; title: string; status: string }[];
  episodeIds: string[];
}

export interface GenerationContext {
  save: SavedPlayer;
  archives: ArchiveContextEntry[];
  /** 被摘要替代的 episode id（生成提示词中改用卷摘要） */
  summarized: Set<string>;
  estimatedPromptBytes: number;
}

/** 组装生成输入：完整 save 保留校验所需原件；覆盖卷的集在提示词中走摘要。 */
export function buildGenerationContext(workspace: Workspace, runtime: WorkspaceRuntime): GenerationContext {
  const save = bridgeSave(workspace, runtime.branch);
  const covered = new Map<string, ArchiveVolume>();
  for (const volume of workspace.volumes) {
    if (volume.derivedFrom.branchId !== runtime.branch.id || volume.strategy.stale) continue;
    for (const member of volume.members) {
      const revision = workspace.revisions.find((r) => r.id === member.revisionId);
      if (revision) covered.set(revision.episodeId, volume);
    }
  }
  const archives = [...new Set(covered.values())].map((volume): ArchiveContextEntry => ({
    volumeId: volume.id, series: volume.series, title: volume.title, narrative: volume.narrative,
    facts: volume.facts, choices: volume.choices.map((c) => ({ chosen: c.chosen })), threads: volume.threads,
    episodeIds: volume.members
      .map((m) => workspace.revisions.find((r) => r.id === m.revisionId)?.episodeId)
      .filter((id): id is string => !!id),
  }));
  const summarized = new Set(covered.keys());
  const estimatedPromptBytes = JSON.stringify(save).length +
    archives.reduce((sum, a) => sum + a.narrative.length + a.facts.length * 40, 0);
  return { save, archives, summarized, estimatedPromptBytes };
}
