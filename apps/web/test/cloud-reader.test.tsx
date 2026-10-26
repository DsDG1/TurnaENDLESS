import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CloudReadBanner } from '../src/cloud/reader.js';
import type { CloudReadView } from '../src/use-player.js';

/** 阅读页状态条只写本机能证明的事实：条数、时间、暂停、冲突。 */

const base: CloudReadView = {
  pending: 0, paused: false, lastSyncedAt: null, cloudVersion: '3', conflicts: 0,
  needsRebase: 0, stopped: null, note: '',
};

const render = (view: CloudReadView | null, syncing = false) => renderToStaticMarkup(createElement(CloudReadBanner, {
  view, syncing, onSync: vi.fn(), exitHref: '#cloud',
}));

describe('云副本阅读状态条', () => {
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

  it('明说只同步阅读事件，生成与元数据没接；退出链接指回云端页', () => {
    const html = render(base);
    expect(html).toContain('只同步阅读事件');
    expect(html).toContain('AI 生成与内容元数据');
    expect(html).toContain('href="#cloud"');
  });

  it('状态还没读到时只说「正在读取」，不显示假的零值', () => {
    const html = render(null);
    expect(html).toContain('正在读取本机同步状态');
    expect(html).not.toContain('没有待推送事件');
  });
});
