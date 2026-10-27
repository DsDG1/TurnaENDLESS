import { describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { buildBackup, applyPlayerCommand, type Workspace } from '@endless/content';
import { deriveCloudCopy } from '@endless/content/cloud';
import { randomUUID } from 'node:crypto';
import { CloudWorkspaceRepository as WorkspaceRepository } from '../src/cloud/repository.js';
import { WorkspaceRepository as GuestWorkspaceRepository } from '../src/storage.js';
import { cloudDigest, cloudNamespace } from '../src/cloud/local.js';
import { cloudTestContent as content, cloudTestWorkspace, cloudTestTime } from '../../../packages/content/test/cloud-fixture.js';
import type { CloudImportReceipt } from '@endless/cloud-contracts';

/** IndexedDB 按主键返回行，业务数组顺序不作为语义；比较前按 id 规范化。 */
const canon = (workspace: Workspace | null) => workspace && ({
  ...workspace,
  revisions: [...workspace.revisions].sort((a, b) => a.id.localeCompare(b.id)),
  branches: [...workspace.branches].sort((a, b) => a.id.localeCompare(b.id)),
  volumes: [...workspace.volumes].sort((a, b) => a.id.localeCompare(b.id)),
  checkpoints: [...workspace.checkpoints].sort((a, b) => a.id.localeCompare(b.id)),
  tickets: [...workspace.tickets].sort((a, b) => a.id.localeCompare(b.id)),
});

async function fixture() {
  const factory = new IDBFactory();
  const deployment = randomUUID(), account = randomUUID(), workspaceId = randomUUID(), device = randomUUID();
  const source = cloudTestWorkspace();
  const copy = deriveCloudCopy(buildBackup(source), cloudTestTime);
  const receipt: CloudImportReceipt = {
    id: randomUUID(), workspaceId, sourceLocalId: source.identity.workspaceId, sourceProfileId: source.profile.id,
    sourceRepositoryRevision: 0, sourceObjectId: randomUUID(), sourceDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64),
    copyDigest: await cloudDigest(copy), copyCreatedAt: cloudTestTime, validationBinding: 'c'.repeat(64),
    copyPolicy: 'endless-cloud-copy/1', contentIds: copy.entries.map((entry) => entry.id),
    revisionIds: copy.revisions.map((entry) => entry.id), seedContentIds: copy.entries.map((entry) => entry.id),
  };
  return { factory, deployment, account, workspaceId, device, source, copy, receipt };
}

describe('C2 账号隔离安装与游客保留', () => {
  it('安装不会写游客或其他账号库，失败和登出不删除原库', async () => {
    const f = await fixture();
    const guest = new GuestWorkspaceRepository(f.factory);
    await guest.commit(f.source);
    const own = new WorkspaceRepository(f.factory, cloudNamespace(f.deployment, f.account, f.workspaceId));
    const other = new WorkspaceRepository(f.factory, cloudNamespace(f.deployment, randomUUID(), f.workspaceId));
    await own.installCloudCopy(f.copy, f.receipt, f.device);
    expect(canon(await guest.load())).toEqual(canon(f.source));
    expect(await other.load()).toBeNull();
    expect((await own.load())!.entries.map((entry) => entry.id)).toEqual(f.source.entries.map((entry) => entry.id));
    expect(() => new WorkspaceRepository(f.factory, 'endless-workspace')).toThrow('游客');
    await Promise.all([guest.close(), own.close(), other.close()]);
  });

  it('安装和元数据同事务；中途写入失败不出现半份内容或回执', async () => {
    const f = await fixture();
    const repo = new WorkspaceRepository(f.factory, cloudNamespace(f.deployment, f.account, f.workspaceId));
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
      if (this.name === 'revisions') throw new DOMException('synthetic quota', 'QuotaExceededError');
      return put.apply(this, args);
    });
    try { await expect(repo.installCloudCopy(f.copy, f.receipt, f.device)).rejects.toThrow(); }
    finally { spy.mockRestore(); }
    expect(await repo.load()).toBeNull();
    expect(await repo.cloudInstallation()).toBeNull();
    await repo.installCloudCopy(f.copy, f.receipt, f.device);
    expect(canon(await repo.load())).toEqual(canon(f.copy));
    await repo.close();
  });

  it('重复领取不覆盖本机后续进度，回执丢失复用持久安装键', async () => {
    const f = await fixture();
    const namespace = cloudNamespace(f.deployment, f.account, f.workspaceId);
    const repo = new WorkspaceRepository(f.factory, namespace);
    const first = await repo.installCloudCopy(f.copy, f.receipt, f.device);
    const progressed: Workspace = {
      ...applyPlayerCommand(content, f.copy, { type: 'advance', scene: 's1', skip: false }),
      identity: { ...f.copy.identity, repositoryRevision: 1 },
    };
    await repo.commit(progressed);
    await repo.close();
    const reopened = new WorkspaceRepository(f.factory, namespace);
    const again = await reopened.installCloudCopy(f.copy, f.receipt, f.device);
    expect(again.existing).toBe(true);
    expect(again.installation).toEqual(first.installation);
    expect(canon(await reopened.load())).toEqual(canon(progressed));
    await reopened.close();
  });

  it('错误摘要、其他工作区或不同导入不能覆盖缓存', async () => {
    const f = await fixture();
    const repo = new WorkspaceRepository(f.factory, cloudNamespace(f.deployment, f.account, f.workspaceId));
    await expect(repo.installCloudCopy(f.copy, { ...f.receipt, copyDigest: '0'.repeat(64) }, f.device)).rejects.toThrow('摘要');
    await repo.installCloudCopy(f.copy, f.receipt, f.device);
    await expect(repo.installCloudCopy(f.copy, { ...f.receipt, id: randomUUID() }, f.device)).rejects.toThrow('覆盖');
    expect(canon(await repo.load())).toEqual(canon(f.copy));
    await repo.close();
  });
});
