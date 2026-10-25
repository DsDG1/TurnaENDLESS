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
    // 不写锁声明就关不了已打开的任务；顺带改别的状态也会被拒绝
    await expect(reopened.commit(cancelled)).rejects.toThrow(/关闭/);
    const sneaky = bump({ ...cancelled, profile: { ...cancelled.profile, label: '顺带修改' } });
    await expect(reopened.commit(sneaky, { closingTicketId: ticket.id })).rejects.toThrow();
    await reopened.commit(cancelled, { closingTicketId: ticket.id });
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
      // 与仓库一致使用当前库版本；用旧版本打开会直接被 IndexedDB 拒绝
      const req = factory.open('endless-workspace', 2);
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
    // 错误要可读并说明原始数据仍在，不能只抛 ZodError 原文
    await expect(corrupted.load()).rejects.toThrow(/原始数据已保留/);
    await corrupted.close();
    await repo.close();
  });

  it('原始快照含全部 store，损坏时仍可读取', async () => {
    const factory = new IDBFactory();
    const { repo } = await seed(factory);
    const snapshot = await repo.rawSnapshot() as {
      meta: unknown; revisions: unknown[]; branches: unknown[]; objects: unknown[]; staging: unknown[];
    };
    expect(snapshot.meta).toBeTruthy();
    expect(snapshot.revisions).toHaveLength(3);
    expect(snapshot.branches).toHaveLength(1);
    expect(Array.isArray(snapshot.objects)).toBe(true);
    expect(snapshot.staging).toEqual([]);
    await repo.close();
  });

  it('导入暂存可读写，并在发布后清空', async () => {
    const factory = new IDBFactory();
    const { repo } = await seed(factory);
    await repo.stage('pending-import', { hello: 1 });
    expect(await repo.staged('pending-import')).toEqual({ hello: 1 });
    await repo.clearStaging();
    expect(await repo.staged('pending-import')).toBeNull();
    await repo.close();
  });
});
