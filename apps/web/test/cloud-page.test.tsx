import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CloudPage, importPayload, type CloudActions } from '../src/cloud/page.js';
import type { CloudState } from '../src/cloud/controller.js';
import type { CloudCapabilities, CloudImportPreview, MeResponse } from '@endless/cloud-contracts';
import { CLOUD_LIMITS } from '@endless/cloud-contracts';

/** 页面只做展示：用静态渲染锁定「预览 ≠ 已导入」「领取 ≠ 可阅读」这些措辞边界。 */

const deployment = crypto.randomUUID();
const account = crypto.randomUUID();
const workspaceId = crypto.randomUUID();

const capabilities: CloudCapabilities = {
  protocol: 'endless-cloud/1',
  features: {
    accounts: true, sessions: true, devices: true, workspaces: true, import: true, objects: true,
    sync: false, generation: false, credits: false, billing: false, payments: false, exports: false, edition: false,
  },
  contracts: { workspace: 'endless-workspace/1' },
  limits: { ...CLOUD_LIMITS },
};

const me: MeResponse = {
  context: { deploymentId: deployment, environment: 'test', localNamespace: `endless-cloud:${deployment}:${account}` },
  account: { id: account, status: 'active', createdAt: '2026-10-25T00:00:00.000Z' },
  device: {
    id: crypto.randomUUID(), name: '这台设备', createdAt: '2026-10-25T00:00:00.000Z',
    lastSeenAt: '2026-10-25T00:00:00.000Z', revokedAt: null, current: true,
  },
  entitlements: [],
};

const preview: CloudImportPreview = {
  id: crypto.randomUUID(), workspaceId, sourceLocalId: 'local-1', sourceProfileId: 'profile-1',
  sourceRepositoryRevision: 2, sourceDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64), objectId: crypto.randomUUID(),
  size: 4096,
  counts: { entries: 3, revisions: 3, branches: 1, volumes: 0, checkpoints: 0, tickets: 0, management: 4 },
  eventCount: 12, pendingLocalTickets: 1, sourceKinds: ['bundled'], relationship: 'new', state: 'ready',
  validationBinding: 'c'.repeat(64), copyPolicy: 'endless-cloud-copy/1', expiresAt: '2026-10-27T00:00:00.000Z',
};

const state = (patch: Partial<CloudState> = {}): CloudState => ({
  status: 'signed-out', capabilities, me: null, devices: [], workspaces: [],
  challenge: null, preview: null, receipt: null, installation: null, sync: null,
  busy: false, phase: '', failure: null,
  ...patch,
});

const actions: CloudActions = {
  refresh: vi.fn(), login: vi.fn(), verify: vi.fn(), logout: vi.fn(),
  preview: vi.fn(), confirm: vi.fn(), claim: vi.fn(),
  openSync: vi.fn(), sync: vi.fn(), pauseSync: vi.fn(), discardConflict: vi.fn(),
};

const render = (patch: Partial<CloudState> = {}, backup: () => unknown = () => ({ format: 'endless-backup' })) =>
  renderToStaticMarkup(createElement(CloudPage, { state: state(patch), actions, backup }));

describe('云端页面状态', () => {
  it('部署未启用云能力时直接说明，不用假数据填充', () => {
    const html = render({ status: 'unavailable', capabilities: null });
    expect(html).toContain('这个部署没有启用云功能');
    expect(html).toContain('页面不会用假数据代替云端状态');
    expect(html).not.toContain('已同步');
  });

  it('未登录只显示登录入口，不显示工作区或领取按钮', () => {
    const html = render();
    expect(html).toContain('用邮箱验证码登录');
    expect(html).toContain('发送验证码');
    expect(html).not.toContain('领取到这台设备');
    expect(html).not.toContain('确认导入');
  });

  it('有预览时明确标注「仅预览，未写入云端」，并给出确认入口', () => {
    const html = render({ status: 'signed-in', me, devices: [me.device], preview });
    expect(html).toContain('仅预览，未写入云端');
    expect(html).toContain('确认导入（激活云端副本）');
    expect(html).toContain('待处理本机任务');
    expect(html).toContain('新云工作区');
    expect(html).not.toContain('云端副本已激活');
  });

  it('预览已过期或已激活时不再显示确认按钮', () => {
    const html = render({ status: 'signed-in', me, preview: { ...preview, state: 'activated' } });
    expect(html).toContain('已激活');
    expect(html).not.toContain('确认导入（激活云端副本）');
  });

  it('领取后说明云库阅读入口尚未接线，并交代增量同步未实现', () => {
    const html = render({ status: 'signed-in', me, workspaces: [{
      id: workspaceId, sourceLocalId: 'local-1', contract: 'endless-workspace/1', cloudVersion: '1', status: 'active',
      role: 'owner', createdAt: '2026-10-25T00:00:00.000Z',
    }] });
    expect(html).toContain('领取到这台设备');
    expect(html).toContain('云库阅读入口尚未接线');
    expect(html).toContain('云端生成、额度与付费都还没实现');
    expect(html).not.toContain('可以在这里打开阅读');
  });

  it('故障显示稳定码与关联 ID，并给出可执行下一步', () => {
    const html = render({
      status: 'signed-in', me,
      failure: { code: 'BASIS_CHANGED', message: '来源存档或验证版本已变化', retryAction: 'resolve_conflict', correlationId: 'corr-abcdef12' },
    });
    expect(html).toContain('BASIS_CHANGED');
    expect(html).toContain('corr-abcdef12');
    expect(html).toContain('需要先解决冲突');
  });

  it('导入上限在客户端先挡一次，且从不截断存档', () => {
    expect(importPayload(null)).toMatchObject({ ok: false, message: expect.stringContaining('还没有') });
    const small = importPayload({ format: 'endless-backup' }, 1024);
    expect(small.ok).toBe(true);
    const tooBig = importPayload({ padding: 'x'.repeat(2000) }, 1024);
    expect(tooBig).toMatchObject({ ok: false, message: expect.stringContaining('不会截断') });
  });

  it('同步面板显示真实待推送与冲突，不写成「已同步」', () => {
    const html = render({
      status: 'signed-in', me,
      capabilities: { ...capabilities, features: { ...capabilities.features, sync: true } },
      sync: {
        workspaceId, pending: 3, paused: false, cursor: 'abc', cloudVersion: '7',
        conflicts: [{ id: 'c-1', streamId: 'brn_00000000-0000-0000-0000-000000000000', baseSeq: 2, cloudSeq: 4, createdAt: '2026-10-26T00:00:00.000Z' }],
        needsRebase: [], lastError: null, lastSyncedAt: null, report: '',
      },
    });
    expect(html).toContain('本机待推送');
    expect(html).toContain('3 条事件');
    expect(html).toContain('还没有成功同步过');
    expect(html).toContain('放弃本机候选');
    expect(html).toContain('冲突不会自动合并');
    expect(html).not.toContain('已同步全部内容');
  });

  it('未启用同步的部署如实说明并禁用按钮；被替换过的分支单独警告', () => {
    const html = render({
      status: 'signed-in', me,
      capabilities: { ...capabilities, features: { ...capabilities.features, sync: false } },
      sync: {
        workspaceId, pending: 0, paused: true, cursor: null, cloudVersion: null,
        conflicts: [], needsRebase: ['brn_00000000-0000-0000-0000-000000000000'],
        lastError: null, lastSyncedAt: null, report: '',
      },
    });
    expect(html).toContain('这个部署没有启用增量同步');
    expect(html).toContain('已停止推送');
  });
});
