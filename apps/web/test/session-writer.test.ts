import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { applyPlayerCommand, buildBackup, createWorkspace, parseBackup, type Workspace } from '@endless/content';
import { WorkspaceRepository } from '../src/storage.js';
import { SessionCommitter, type WorkspaceCommitter } from '../src/session-writer.js';
import { content } from '../src/content/catalog.js';

describe('写入协调（SessionCommitter）', () => {
  it('导入备份后基线自动前进，下一次写入不会被自己的 CAS 拒掉', async () => {
    const factory = new IDBFactory();
    const repo = new WorkspaceRepository(factory);
    const writer = new SessionCommitter(repo, -1);

    const initial = await writer.commit(createWorkspace(content));
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;

    // 导入同源备份：相当于「导出 → 重新导入」
    const preview = parseBackup(JSON.parse(JSON.stringify(buildBackup(initial.workspace))), initial.workspace);
    const imported = await writer.commit(preview.backup.workspace.data);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    // 导入后的第一次普通写入必须成功；旧实现不推进基线，这里会报「另一个窗口已更新」
    const played = applyPlayerCommand(content, imported.workspace, { type: 'text', large: true });
    const next = await writer.commit(played);
    expect(next.ok).toBe(true);
    if (next.ok) expect(next.workspace.branches[0]?.session.largeText).toBe(true);

    const loaded = await repo.load();
    expect(loaded?.branches[0]?.session.largeText).toBe(true);
    expect(loaded?.identity.repositoryRevision).toBe(writer.committedRevision);
    await repo.close();
  });

  it('提交失败时返回原因且不推进基线，重试仍用同一个版本号', async () => {
    let attempts = 0;
    const seen: number[] = [];
    const flaky: WorkspaceCommitter = {
      async commit(next) {
        attempts += 1;
        seen.push(next.identity.repositoryRevision);
        if (attempts === 1) throw new Error('另一个窗口已更新进度，请刷新后继续');
      },
    };
    const writer = new SessionCommitter(flaky, 5);
    const workspace = createWorkspace(content);

    const failed = await writer.commit(workspace);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error).toMatch(/另一个窗口/);
    expect(writer.committedRevision).toBe(5);

    const retried = await writer.commit(workspace);
    expect(retried.ok).toBe(true);
    expect(writer.committedRevision).toBe(6);
    expect(seen).toEqual([6, 6]);
  });

  it('关闭票据时把 closingTicketId 透传给仓库', async () => {
    const seen: (string | undefined)[] = [];
    const writer = new SessionCommitter({
      async commit(_next: Workspace, options) {
        seen.push(options?.closingTicketId);
      },
    }, -1);
    await writer.commit(createWorkspace(content), { closingTicketId: 'tkt_1' });
    expect(seen).toEqual(['tkt_1']);
  });
});
