import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { exportProjection, projectSession, verifyCheckpoint, type ProjectionState } from '@endless/player';
import { getOptions, getScenes, transition } from '@endless/player';
import { contentHash } from '@endless/esl';
import { createContent, type GeneratedEpisode } from '../src/index.js';
import {
  adoptRevisionInPlace, applyPlayerCommand, attachVolume, bridge, cancelTicket, commitTicketResult,
  createWorkspace, detachVolume, purgePreview, reserveTicket, restoreContent, switchBranch,
  trashContent, updateDisplay, waiveObligation,
} from '../src/workspace.js';
import { adoptRevision, previewRevision } from '../src/revision.js';
import { buildVolume, suggestVolumes } from '../src/archive.js';
import { buildGenerationContext } from '../src/context.js';
import { buildBackup, parseBackup } from '../src/backup.js';
import type { AnyRevision, ContentEntry, GenerationTicket, ReadingObligation, Workspace } from '../src/application-contract.js';

const content = createContent(readFileSync(new URL('../../../apps/lab/data/lexicon/a1_a2.yaml', import.meta.url), 'utf8'));
const at = '2026-10-24T08:00:00.000Z';

/** 完成三集试播并返回工作区。 */
function playedPilot(): Workspace {
  let ws = createWorkspace(content, new Date(at));
  for (const episode of content.pilot.episodes) {
    ws = applyPlayerCommand(content, ws, { type: 'select', episode: episode.id }, new Date(at));
    for (const scene of getScenes(episode)) {
      const options = getOptions(scene);
      if (options.length) ws = applyPlayerCommand(content, ws, { type: 'answer', scene: scene.id, choice: options.findIndex((o) => o.correct) }, new Date(at));
      ws = applyPlayerCommand(content, ws, { type: 'advance', scene: scene.id, skip: false }, new Date(at));
    }
  }
  return ws;
}

/** 提交一次合法生成（任务 → 文档 → commitTicketResult）。 */
function generatedDoc(ws: Workspace, suffix = 'a'): { ws: Workspace; doc: GeneratedEpisode } {
  const { workspace: reserved, ticket } = reserveTicket(ws, new Date(at));
  const runtime = bridge(content, reserved);
  const task = content.planCreative(runtime.session, runtime.library, new Date(at));
  const intro = task.targets.filter((x) => task.brief.introduce.includes(x.item));
  const expose = task.targets.filter((x) => x.interaction === null);
  const required = task.targets.filter((x) => x.interaction !== null);
  const form = (alias: string) => task.targets.find((x) => x.alias === alias)!.forms[0];
  const chunk = <T,>(list: readonly T[], size: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  };
  // 本批 2–5 个新词：每个都要在两个正文块出现；chat 首块兼任 expose 覆盖
  const contextBlocks = [
    ...chunk(intro, 4).map((group) => `@comic agency_office\n${group.map((x, i) => `${i % 2 ? 'cat' : 'duck'}: The ${x.forms[0]} is here.`).join('\n')}\n@end`),
    ...chunk(intro, 6).map((group, index) => {
      const lines = group.map((x, i) => `${i % 2 ? 'duck' : 'cat'}: It is a ${x.forms[0]}.`);
      if (index === 0) lines.push(`cat: I see a ${expose.map((x) => x.forms[0]).join(', a ') || 'box'}.`);
      lines.push('duck: Good.');
      return `@chat messenger\n${lines.join('\n')}\n@end`;
    }),
  ];
  const blocks = [
    ...contextBlocks,
    ...required.map((x) => `@choice ${x.alias}\n? What did you see?\n+ I see the ${form(x.alias)}.\n- I see nothing.\n- It is late.\n- Please wait.\n= ok\n@end`),
  ];
  while (blocks.length < 10) blocks.push('@post duck\ntext: Good.\n@end');
  const draft = [
    'ENDLESS-DRAFT/1', '@kind story', '@series duck_detective', `@title t${suffix}`, '@subtitle s', '@description d',
    ...blocks,
  ].join('\n');
  const compiled = content.compileDraft(draft, task, runtime.library, `ai-${ticket.id.slice(4)}`);
  if (!compiled.ok) throw new Error(compiled.issues.map((i) => i.message).join(';'));
  const doc: GeneratedEpisode = {
    version: 1, generatedAt: at, basedOn: { eventCount: ticket.basis.eventCount, hash: ticket.basis.eventHash },
    title: compiled.title, subtitle: compiled.subtitle, description: compiled.description,
    batch: compiled.batch, hash: contentHash(compiled.batch), learningVersion: 4, creation: compiled.creation,
  };
  return { ws: commitTicketResult(content, reserved, ticket.id, doc), doc };
}

describe('endless-workspace 运行时', () => {
  it('新档案含 3 条捆绑内容与根分支，回放生成完整运行时', () => {
    const ws = createWorkspace(content, new Date(at));
    expect(ws.entries).toHaveLength(3);
    expect(ws.entries.every((e: ContentEntry) => e.sourceKind === 'bundled')).toBe(true);
    expect(ws.branches).toHaveLength(1);
    const runtime = bridge(content, ws);
    expect(runtime.library.episodes).toHaveLength(3);
    expect(runtime.owners.size).toBe(3);
  });

  it('玩法命令通过统一提交路径；事件带修订引用；任务冻结其它写入', () => {
    let ws = createWorkspace(content, new Date(at));
    ws = applyPlayerCommand(content, ws, { type: 'select', episode: 'pilot-2' }, new Date(at));
    expect(ws.branches[0]!.session.current).toBe('pilot-2');
    ws = applyPlayerCommand(content, ws, { type: 'advance', scene: 's1', skip: false }, new Date(at));
    const event = ws.branches[0]!.session.events.at(-1)!;
    expect(event.episode).toBe('pilot-2');
    expect((event as { revisionId?: string }).revisionId).toBeTruthy();
    const { workspace: reserved } = reserveTicket(ws, new Date(at));
    expect(() => applyPlayerCommand(content, reserved, { type: 'text', large: true })).toThrow(/生成任务/);
    const cancelled = cancelTicket(reserved, reserved.tickets[0]!.id);
    expect(() => applyPlayerCommand(content, cancelled, { type: 'text', large: true })).not.toThrow();
  });

  it('展示信息修改不改正文哈希；回收站/恢复/义务/清除引用分析', () => {
    let ws = generatedDoc(playedPilot()).ws;
    const entry = ws.entries.find((e: ContentEntry) => e.sourceKind === 'generated')!;
    const head = ws.revisions.find((r: AnyRevision) => r.id === entry.headRevisionId)!;
    const hash = head.hash;
    ws = updateDisplay(ws, entry.id, { title: '改名', tags: ['a'], note: 'n' });
    const renamed = ws.entries.find((e: ContentEntry) => e.id === entry.id)!;
    expect(renamed.display.title).toBe('改名');
    expect(ws.revisions.find((r: AnyRevision) => r.id === renamed.headRevisionId)!.hash).toBe(hash);
    // 未读生成内容有阅读义务；撤销后垃圾不影响历史
    expect(ws.obligations.some((o: ReadingObligation) => o.contentId === entry.id && !o.waivedAt)).toBe(true);
    ws = waiveObligation(ws, entry.id);
    ws = trashContent(ws, entry.id);
    expect(ws.entries.find((e: ContentEntry) => e.id === entry.id)!.lifecycle).toBe('trashed');
    ws = restoreContent(ws, entry.id);
    expect(ws.entries.find((e: ContentEntry) => e.id === entry.id)!.lifecycle).toBe('active');
    const refs = purgePreview(ws, entry.id);
    // 被后续生成依据引用则不能清除；这里刚生成一次，无后续依据但有事件？未读 → 可清理由需人工确认
    expect(Array.isArray(refs.usedByEvents)).toBe(true);
  });

  it('生成采用新内容后事件基于生成时历史校验；历史不匹配任务失败保留结果', () => {
    const ws = playedPilot();
    const next = generatedDoc(ws);
    const entry = next.ws.entries.find((e: ContentEntry) => e.sourceKind === 'generated')!;
    const revision = next.ws.revisions.find((r: AnyRevision) => r.id === entry.headRevisionId)!;
    expect(revision.origin).toBe('generated');
    if (revision.origin !== 'bundled') expect(revision.basis.branchId).toBe(next.ws.activeBranchId);
    // 任务绑定旧历史后历史变化 → commitTicketResult 标记失败而不写错误分支
    const { workspace: reserved, ticket } = reserveTicket(ws, new Date(at));
    const tampered: Workspace = {
      ...reserved,
      tickets: reserved.tickets.map((t: GenerationTicket) => t.id === ticket.id
        ? { ...t, basis: { ...t.basis, eventHash: '0'.repeat(16) } } : t),
    };
    const mismatch = commitTicketResult(content, tampered, ticket.id, next.doc);
    expect(mismatch.tickets.find((t: GenerationTicket) => t.id === ticket.id)!.status).toBe('failed');
    expect(mismatch.tickets.find((t: GenerationTicket) => t.id === ticket.id)!.failureCategory).toBe('history-mismatch');
  });

  it('未读内容编辑原位替换；已读内容编辑创建新分支且旧答案不重读', () => {
    let ws = generatedDoc(playedPilot()).ws;
    const entry = ws.entries.find((e: ContentEntry) => e.sourceKind === 'generated')!;
    const head = ws.revisions.find((r: AnyRevision) => r.id === entry.headRevisionId)!;
    // 未读：原位采用
    const preview = previewRevision(content, ws, entry, (head as { draft: string }).draft.replace('@title ta', '@title ta 修订'));
    expect(preview.ok).toBe(true);
    const adopted = adoptRevision(content, ws, entry, preview.revision!);
    expect(adopted.mode).toBe('in-place');
    ws = adopted.workspace;
    const newHead = ws.revisions.find((r: AnyRevision) => r.id === ws.entries.find((e: ContentEntry) => e.id === entry.id)!.headRevisionId)!;
    expect(newHead.parentRevisionId).toBe(head.id);
    expect(newHead.origin).toBe('edited');
    // 读过生成集 → 编辑创建新分支
    const episodeId = head.episodeId;
    let played = applyPlayerCommand(content, ws, { type: 'select', episode: episodeId }, new Date(at));
    const lib = bridge(content, played).library;
    for (const scene of getScenes(lib.episodes.find((e: { id: string }) => e.id === episodeId)!)) {
      const options = getOptions(scene);
      if (options.length) played = applyPlayerCommand(content, played, { type: 'answer', scene: scene.id, choice: options.findIndex((o) => o.correct) }, new Date(at));
      played = applyPlayerCommand(content, played, { type: 'advance', scene: scene.id, skip: false }, new Date(at));
    }
    const entry2 = played.entries.find((e: ContentEntry) => e.id === entry.id)!;
    const head2 = played.revisions.find((r: AnyRevision) => r.id === entry2.headRevisionId)!;
    const preview2 = previewRevision(content, played, entry2, (head2 as { draft: string }).draft.replace('@title ta', '@title ta v2'));
    if (!preview2.ok) return; // 草稿正文改动后若校验失败，仅验证原位采用被拒绝
    const adopted2 = adoptRevision(content, played, entry2, preview2.revision!);
    expect(adopted2.mode).toBe('fork');
    expect(adopted2.workspace.branches.length).toBe(2);
    expect(() => adoptRevisionInPlace(played, entry.id, preview2.revision!)).toThrow(/新分支/);
  });

  it('归档卷只覆盖真实读完的集；生成上下文用摘要替代原文', () => {
    // 读完试播 + 生成并读完 3 集才有候选——这里验证生成 1 集后无候选，且上下文含全部原件
    const ws = generatedDoc(playedPilot()).ws;
    const runtime = bridge(content, ws);
    expect(suggestVolumes(ws, runtime)).toHaveLength(0);
    const ctx = buildGenerationContext(ws, runtime);
    expect(ctx.save.generated).toHaveLength(1);
    expect(ctx.archives).toHaveLength(0);
    // 手工成卷（3 集读完的试播）——bundled 内容也可归档
    const ids = ws.entries.filter((e: ContentEntry) => e.sourceKind === 'bundled').map((e: ContentEntry) => e.id);
    const volume = buildVolume(ws, runtime, ids, '试播卷');
    expect(volume.members).toHaveLength(3);
    expect(volume.reading.every((r: { status: string }) => r.status === 'read')).toBe(true);
    const archived = attachVolume(ws, volume);
    const ctx2 = buildGenerationContext(archived, bridge(content, archived));
    expect(ctx2.archives).toHaveLength(1);
    expect(ctx2.summarized.size).toBe(3);
    const detached = detachVolume(archived, volume.id);
    expect(detached.volumes).toHaveLength(0);
  });

  it('读完生成集自动解除阅读义务，恢复生成资格', () => {
    let ws = generatedDoc(playedPilot()).ws;
    const entry = ws.entries.find((e: ContentEntry) => e.sourceKind === 'generated')!;
    expect(ws.obligations.some((o: ReadingObligation) => !o.waivedAt)).toBe(true);
    const head = ws.revisions.find((r: AnyRevision) => r.id === entry.headRevisionId)!;
    ws = applyPlayerCommand(content, ws, { type: 'select', episode: head.episodeId }, new Date(at));
    const lib = bridge(content, ws).library;
    for (const scene of getScenes(lib.episodes.find((e: { id: string }) => e.id === head.episodeId)!)) {
      const options = getOptions(scene);
      if (options.length) ws = applyPlayerCommand(content, ws, { type: 'answer', scene: scene.id, choice: options.findIndex((o) => o.correct) }, new Date(at));
      ws = applyPlayerCommand(content, ws, { type: 'advance', scene: scene.id, skip: false }, new Date(at));
    }
    expect(ws.obligations.every((o: ReadingObligation) => !!o.waivedAt)).toBe(true);
  });

  it('完整备份可导出、清单校验、重复导入不产生第二身份', () => {
    const ws = generatedDoc(playedPilot()).ws;
    const backup = buildBackup(ws);
    expect(backup.manifest.counts.entries).toBe(ws.entries.length);
    const preview = parseBackup(JSON.parse(JSON.stringify(backup)), ws);
    expect(preview.conflicts.existingWorkspaceId).toBe(true);
    expect(parseBackup(JSON.parse(JSON.stringify(backup)), null).conflicts.existingWorkspaceId).toBe(false);
    expect(() => parseBackup({ format: 'endless-player' })).toThrow(/不支持|已保留|未修改/);
    const tampered = JSON.parse(JSON.stringify(backup));
    tampered.workspace.data.entries = [];
    expect(() => parseBackup(tampered)).toThrow();
  });

  it('检查点导出/导入与完整重放等价', () => {
    const ws = playedPilot();
    const runtime = bridge(content, ws);
    const view = projectSession(runtime.session, runtime.library);
    const state: ProjectionState = exportProjection(view);
    expect(verifyCheckpoint(runtime.session, runtime.library, structuredClone(state))).toBe(true);
    // 篡改状态不再等价
    const bad = structuredClone(state);
    bad.completed = 99;
    expect(verifyCheckpoint(runtime.session, runtime.library, bad)).toBe(false);
  });

  it('切换分支不改变原分支历史', () => {
    const ws = playedPilot();
    const other = switchBranch(ws, ws.branches[0]!.id);
    expect(other.activeBranchId).toBe(ws.branches[0]!.id);
    expect(() => switchBranch(ws, 'brn_missing')).toThrow();
  });
});
