import { describe, expect, it, vi } from 'vitest';
import { contentHash } from '@endless/esl';
import { exportProjection, projectSession } from '@endless/player';
import { applyPlayerCommand, attachVolume, bridge, buildBackup, buildVolume, newId, reserveTicket } from '../src/index.js';
import { deriveCloudCopy, validateCloudBackup } from '../src/cloud.js';
import { cloudTestContent as content, cloudTestTime, cloudTestWorkspace } from './cloud-fixture.js';

describe('C2 原件完整校验与显式领取副本', () => {
  it('校验当前备份和真实生成正文，保留源字节语义和所有业务 ID', () => {
    const backup = buildBackup(cloudTestWorkspace(true));
    const original = JSON.stringify(backup);
    expect(validateCloudBackup(content, backup)).toEqual(backup);
    expect(JSON.stringify(backup)).toBe(original);
    const copy = deriveCloudCopy(backup, cloudTestTime);
    expect(copy.entries.map((entry) => entry.id)).toEqual(backup.workspace.data.entries.map((entry) => entry.id));
    expect(copy.revisions).toEqual(backup.workspace.data.revisions);
    expect(copy.identity.repositoryRevision).toBe(0);
  });

  it('结构可通过的错误捆绑摘要和错配事件修订不能成为云端事实', () => {
    const backup = buildBackup(applyPlayerCommand(content, cloudTestWorkspace(), { type: 'advance', scene: 's1', skip: false }));
    const badSeed = structuredClone(backup);
    badSeed.workspace.data.revisions[0]!.hash = '0'.repeat(16);
    expect(() => validateCloudBackup(content, badSeed)).toThrow();
    const badEvent = structuredClone(backup);
    badEvent.workspace.data.branches[0]!.session.events[0]!.revisionId = badEvent.workspace.data.revisions[1]!.id;
    expect(() => validateCloudBackup(content, badEvent)).toThrow();
  });

  it('篡改生成原文并重算短 hash，或更改生成依据仍拒绝', () => {
    const backup = buildBackup(cloudTestWorkspace(true));
    for (const change of ['draft', 'basis'] as const) {
      const bad = structuredClone(backup);
      const revision = bad.workspace.data.revisions.find((entry) => entry.origin !== 'bundled')!;
      if (change === 'draft') revision.draft += '\n@post duck\ntext: Forged.\n@end';
      if (change === 'basis') revision.basis.eventHash = '0'.repeat(16);
      revision.hash = contentHash(revision.batch);
      expect(() => validateCloudBackup(content, bad)).toThrow();
    }
  });

  it('恢复使用原 plannedAt，不因导入时跨过复习到期点而重新规划', () => {
    const backup = buildBackup(cloudTestWorkspace(true));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
      expect(validateCloudBackup(content, backup)).toEqual(backup);
    } finally { vi.useRealTimers(); }
  });

  it('不只验证当前分支：隐藏修订和分支损坏同样拒绝', () => {
    const backup = buildBackup(cloudTestWorkspace(true));
    const bad = structuredClone(backup);
    const revision = structuredClone(bad.workspace.data.revisions.at(-1)!);
    revision.id = newId('revision');
    revision.ordinal = 2;
    if (revision.origin !== 'bundled') {
      revision.origin = 'edited';
      revision.parentRevisionId = bad.workspace.data.revisions.at(-1)!.id;
      revision.draft = 'invalid hidden revision';
    }
    bad.workspace.data.entries.at(-1)!.revisionIds.push(revision.id);
    bad.workspace.data.revisions.push(revision);
    bad.manifest.counts.revisions++;
    expect(() => validateCloudBackup(content, bad)).toThrow();
  });

  it('未知字段、会话/Key 字段、事件额外载荷和 Edition 均拒绝而非剥离后上传', () => {
    const backup = buildBackup(applyPlayerCommand(content, cloudTestWorkspace(), { type: 'advance', scene: 's1', skip: false }));
    expect(() => validateCloudBackup(content, { ...backup, token: 'synthetic-secret' })).toThrow();
    const bad = structuredClone(backup);
    Object.assign(bad.workspace.data.branches[0]!.session.events[0]!, { providerKey: 'synthetic-secret' });
    expect(() => validateCloudBackup(content, bad)).toThrow();
    expect(() => validateCloudBackup(content, { format: 'edition-backup', version: 1, trustRoot: 'unknown' })).toThrow();
  });

  it('未完成本机任务只在显式副本策略中终止等待，原件不变', () => {
    const reserved = reserveTicket(cloudTestWorkspace(), new Date(cloudTestTime)).workspace;
    const backup = buildBackup(reserved);
    validateCloudBackup(content, backup);
    const copy = deriveCloudCopy(backup, cloudTestTime);
    expect(copy.tickets[0]).toMatchObject({ status: 'failed', failureCategory: 'local-origin-only' });
    expect(backup.workspace.data.tickets[0]!.status).toBe('reserved');
    expect(copy.profile.boundAccountId).toBeNull();
  });

  it('检查点由原事件重放复算，不能信任自报 verified', () => {
    const workspace = cloudTestWorkspace();
    const runtime = bridge(content, workspace);
    workspace.checkpoints.push({
      id: newId('checkpoint'), branchId: workspace.activeBranchId,
      eventPrefix: { count: 0, hash: contentHash({ catalog: runtime.session.catalog, events: [] }) },
      projectorVersion: 'player-projection-1', createdAt: cloudTestTime, verified: true,
      state: JSON.parse(JSON.stringify(exportProjection(projectSession(runtime.session, runtime.library)))),
    });
    const backup = buildBackup(workspace);
    expect(validateCloudBackup(content, backup).workspace.data.checkpoints).toHaveLength(1);
    backup.workspace.data.checkpoints[0]!.state.completed = 999;
    expect(() => validateCloudBackup(content, backup)).toThrow();
  });

  it('归档事实/引文按真实前缀复算，不信任可伪造的摘要', () => {
    let workspace = cloudTestWorkspace(true);
    const runtime = bridge(content, workspace);
    workspace = attachVolume(workspace, buildVolume(workspace, runtime, workspace.entries.slice(0, 3).map((entry) => entry.id)));
    const backup = buildBackup(workspace);
    expect(validateCloudBackup(content, backup).workspace.data.volumes).toHaveLength(1);
    backup.workspace.data.volumes[0]!.quotes[0]!.text = 'Never actually read.';
    expect(() => validateCloudBackup(content, backup)).toThrow();
  });
});
