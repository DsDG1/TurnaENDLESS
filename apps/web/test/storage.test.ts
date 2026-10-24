import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { applyPlayerCommand, createWorkspace, reserveTicket, cancelTicket, type Workspace } from '@endless/content';
import { WorkspaceRepository } from '../src/storage.js';
import { content } from '../src/content/catalog.js';

const bump = (workspace: Workspace): Workspace => ({
  ...workspace,
  identity: { ...workspace.identity, repositoryRevision: workspace.identity.repositoryRevision + 1 },
});

async function seed(factory: IDBFactory) {
  const repo = new WorkspaceRepository(factory);
  const ws = createWorkspace(content);
  await repo.commit(ws);
  return { repo, ws };
}

describe('endless-workspace 原子存档', () => {
  it('保存并重新打开后可恢复会话与内容', async () => {
    const factory = new IDBFactory();
    const { repo, ws } = await seed(factory);
    const next = bump(applyPlayerCommand(content, ws, { type: 'text', large: true }));
    await repo.commit(next);
    await repo.close();
    const reopened = new WorkspaceRepository(factory);
    const loaded = await reopened.load();
    expect(loaded?.identity.workspaceId).toBe(next.identity.workspaceId);
    expect(loaded?.branches[0]?.session.largeText).toBe(true);
    expect(loaded?.entries.length).toBe(3);
    expect(loaded?.revisions.every((r) => r.origin === 'bundled')).toBe(true);
    await reopened.close();
  });

  it('并发窗口不能覆盖另一个窗口已保存的进度', async () => {
    const factory = new IDBFactory();
    const { repo: first, ws } = await seed(factory);
    const second = new WorkspaceRepository(factory);
    const advanced = bump(applyPlayerCommand(content, ws, { type: 'select', episode: 'pilot-2' }));
    await first.commit(advanced);
    const stale = bump({ ...ws, profile: { ...ws.profile, label: '旧窗口' } });
    await expect(second.commit(stale)).rejects.toThrow(/另一个窗口/);
    const loaded = await first.load();
    expect(loaded?.branches[0]?.session.current).toBe('pilot-2');
    await first.close();
    await second.close();
  });

  it('生成任务跨刷新保留；取消后可正常写入', async () => {
    const factory = new IDBFactory();
    const { repo, ws } = await seed(factory);
    const { workspace: reserved, ticket } = reserveTicket(ws);
    await repo.commit(bump(reserved));
    const reopened = new WorkspaceRepository(factory);
    const loaded = await reopened.load();
    expect(loaded?.tickets.find((t) => t.id === ticket.id)?.status).toBe('reserved');
    const cancelled = bump(cancelTicket(loaded!, ticket.id));
    await reopened.commit(cancelled);
    const after = await reopened.load();
    expect(after?.tickets.find((t) => t.id === ticket.id)?.status).toBe('cancelled');
    const played = bump(applyPlayerCommand(content, after!, { type: 'text', large: true }));
    await reopened.commit(played);
    expect((await reopened.load())?.branches[0]?.session.largeText).toBe(true);
    await repo.close();
    await reopened.close();
  });

  it('不兼容的存档在 load 时抛出，数据仍保留', async () => {
    const factory = new IDBFactory();
    const { repo, ws } = await seed(factory);
    await repo.close();
    // 直接写坏 meta：entries 与 revisions 不一致
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open('endless-workspace', 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['meta', 'revisions'], 'readwrite');
      tx.objectStore('meta').put({ key: 'workspace', identity: ws.identity, profile: ws.profile, entries: ws.entries, obligations: [], activeBranchId: ws.activeBranchId, management: [] }, 'workspace');
      tx.objectStore('revisions').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    const corrupted = new WorkspaceRepository(factory);
    await expect(corrupted.load()).rejects.toThrow();
    await corrupted.close();
    await repo.close();
  });
});
