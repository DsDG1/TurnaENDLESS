import { describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { applyPlayerCommand, createWorkspace } from '@endless/content';
import { WorkspaceRepository } from '../src/storage.js';
import { CloudWorkspaceRepository } from '../src/cloud/repository.js';
import { SessionCommitter } from '../src/session-writer.js';
import { content } from '../src/content/catalog.js';

async function database(factory: IDBFactory) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('endless-workspace', 2);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}

describe('独立游客仓库边界', () => {
  it('两种适配器在打开 IDB 前拒绝错误命名空间', () => {
    const factory = new IDBFactory(), open = vi.spyOn(factory, 'open');
    expect(() => new WorkspaceRepository(factory, 'endless-cloud:unknown')).toThrow('游客仓库');
    expect(() => new CloudWorkspaceRepository(factory, 'endless-workspace')).toThrow('游客');
    expect(open).not.toHaveBeenCalled();
  });

  it('游客提交不读取云 sidecar 正文；未知附加记录拒绝且保留原件和版本', async () => {
    const factory = new IDBFactory(), repo = new WorkspaceRepository(factory), workspace = createWorkspace(content);
    await repo.commit(workspace);
    const db = await database(factory), unknown = { format: 'future-sync/9', outbox: ['preserved'] };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('sync', 'readwrite');
      tx.objectStore('sync').put(unknown, 'future');
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    });
    const before = await repo.rawSnapshot(), get = IDBObjectStore.prototype.get;
    const reads: string[] = [];
    const spy = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) {
      reads.push(this.name); return get.call(this, key);
    });
    try {
      const writer = new SessionCommitter(repo, 0);
      const result = await writer.commit(applyPlayerCommand(content, workspace, { type: 'text', large: true }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('未识别的附加记录');
      expect(writer.committedRevision).toBe(0);
      expect(reads).not.toContain('sync');
    } finally { spy.mockRestore(); }
    expect(await repo.rawSnapshot()).toEqual(before);
    expect(await new Promise(resolve => { const request = db.transaction('sync', 'readonly').objectStore('sync').get('future'); request.onsuccess = () => resolve(request.result); })).toEqual(unknown);
    db.close(); await repo.close();
  });

  it('首次写入遇到残存正文而缺少 meta 时拒绝，不清空残存记录', async () => {
    const factory = new IDBFactory(), repo = new WorkspaceRepository(factory), db = await database(factory);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('revisions', 'readwrite'); tx.objectStore('revisions').put({ id: 'orphan', future: true }, 'orphan');
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    });
    const before = await repo.rawSnapshot();
    await expect(repo.commit(createWorkspace(content))).rejects.toThrow('缺少 meta');
    expect(await repo.rawSnapshot()).toEqual(before);
    db.close(); await repo.close();
  });
});
