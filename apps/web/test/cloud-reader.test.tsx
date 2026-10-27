import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CloudReadBanner } from '../src/cloud/reader.js';
import type { CloudReadView } from '../src/cloud/use-player.js';
import type { MetadataState } from '../src/cloud/metadata.js';
import type { ArchiveView } from '../src/cloud/archives.js';

/** 阅读页状态条只写本机能证明的事实：条数、时间、暂停、冲突。 */

const base: CloudReadView = {
  pending: 0, paused: false, lastSyncedAt: null, cloudVersion: '3', conflicts: 0,
  needsRebase: 0, stopped: null, note: '',
};

const render = (view: CloudReadView | null, syncing = false) => renderToStaticMarkup(createElement(CloudReadBanner, {
  view, syncing, onSync: vi.fn(), exitHref: '#cloud',
}));

describe('云副本阅读状态条', () => {
  it('归档未确认时不写成功，冲突提供绑定当前版本的显式选择', () => {
    const pending: NonNullable<ArchiveView['pending']> = { request: {
      workspaceId: crypto.randomUUID(), commandId: crypto.randomUUID(), type: 'archive', volumeId: `vol_${crypto.randomUUID()}`,
      baseVersion: 0, title: '候选归档', basis: { streamId: `brn_${crypto.randomUUID()}`, eventCount: 0, eventHash: 'a'.repeat(16) },
      members: [{ contentId: `ent_${crypto.randomUUID()}`, revisionId: `rev_${crypto.randomUUID()}`, lifecycleVersion: 0, displayVersion: 0 }],
    } };
    const archives: ArchiveView = { format: 'archive-outbox/1', known: { version: 1, volumes: [] }, pending };
    const renderArchive = () => renderToStaticMarkup(createElement(CloudReadBanner, { view: base, syncing: false, onSync: vi.fn(), exitHref: '#cloud', archives }));
    expect(renderArchive()).toContain('归档请求待确认'); expect(renderArchive()).toContain('尚未标记为归档成功');
    pending.resolution = { workspaceId: pending.request.workspaceId, commandId: pending.request.commandId, outcome: 'conflict', reason: 'precondition', snapshot: { state: { version: 1, volumes: [] }, lifecycle: [] }, display: [] };
    expect(renderArchive()).toContain('归档请求需要处理'); expect(renderArchive()).toContain('按最新版本重新提交');
    expect(renderArchive()).toContain('采用云端归档状态');
  });
  it('并发修改展示两份标题、标签、备注，以及显式选择入口', () => {
    const workspaceId = crypto.randomUUID(), contentId = `ent_${crypto.randomUUID()}`;
    const request = { workspaceId, contentId, commandId: crypto.randomUUID(), type: 'set-display' as const,
      baseVersion: 0, value: { title: '本机名称', tags: ['本机标签'], note: '本机备注' } };
    const entry = { contentId, version: 1, value: { title: '云端名称', tags: ['云端标签'], note: '云端备注' }, updatedAt: '2026-10-26T00:00:00.000Z' };
    const metadata: MetadataState = { format: 'metadata-outbox/1', known: { [contentId]: entry },
      pending: { [contentId]: { request, conflict: { workspaceId, commandId: request.commandId, outcome: 'conflict', entry } } } };
    const html = renderToStaticMarkup(createElement(CloudReadBanner, {
      view: { ...base, metadataPending: 1, metadataConflicts: 1 }, syncing: false,
      metadata, onSync: vi.fn(), onResolveMetadata: vi.fn(), exitHref: '#cloud',
    }));
    for (const text of ['本机名称', '云端名称', '本机标签', '云端标签', '本机备注', '云端备注',
      '保留本机修改并重新提交', '采用云端展示信息', '1 条待同步 · 1 个冲突']) expect(html).toContain(text);
  });
  it('独立分支可在阅读器里选择，并明确选择仅属于本机', () => {
    const html = renderToStaticMarkup(createElement(CloudReadBanner, {
      view: base, syncing: false, onSync: vi.fn(), exitHref: '#cloud',
      branches: [{ id: 'main', label: '主线' }, { id: 'kept', label: '主线 · 离线保留' }],
      activeBranchId: 'kept', onBranch: vi.fn(),
    }));
    expect(html).toContain('当前阅读分支（仅这台设备）');
    expect(html).toContain('value="kept" selected=""');
    expect(html).toContain('主线 · 离线保留');
  });
  it('还没有同步过就不写「已同步」；待推送条数如实显示', () => {
    const html = render({ ...base, pending: 3 });
    expect(html).toContain('3 条事件');
    expect(html).toContain('还没有成功同步过');
    expect(html).not.toContain('已同步全部内容');
  });

  it('没有待推送事件也只说到「没有待推送事件」，不替其他设备下结论', () => {
    const html = render({ ...base, lastSyncedAt: '2026-10-26T09:00:00.000Z' });
    expect(html).toContain('没有待推送事件');
    expect(html).not.toContain('已同步全部内容');
    expect(html).not.toContain('所有设备');
  });

  it('冲突与历史替换分别给出可操作的说明', () => {
    expect(render({ ...base, stopped: 'conflict', conflicts: 1 })).toContain('整批未上传');
    expect(render({ ...base, stopped: 'cursor' })).toContain('游标已过期');
    expect(render({ ...base, needsRebase: 2 })).toContain('有 2 个分支的本机历史被整体替换过');
    expect(render({ ...base, conflicts: 2 })).toContain('2 个待处理');
  });

  it('同步中按钮不重复触发；暂停时按钮禁用并说明事件继续排队', () => {
    const syncing = render(base, true);
    expect(syncing).toContain('正在同步…');
    expect(syncing).toContain('disabled');
    const paused = render({ ...base, paused: true });
    expect(paused).toContain('已暂停（事件继续排队）');
  });

  it('说明已接入的同步范围和云生成边界；退出链接指回云端页', () => {
    const html = render(base);
    expect(html).toContain('同步阅读事件、展示信息、回收站、归档和修订');
    expect(html).toContain('云端 AI 生成尚未接入');
    expect(html).toContain('回收不解除阅读义务');
    expect(html).toContain('href="#cloud"');
  });

  it('状态还没读到时只说「正在读取」，不显示假的零值', () => {
    const html = render(null);
    expect(html).toContain('正在读取本机同步状态');
    expect(html).not.toContain('没有待推送事件');
  });
});
