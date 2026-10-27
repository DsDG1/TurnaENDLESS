import type { Workspace } from '@endless/content';
import { WorkspaceDatabase } from './storage/database.js';
import { assertWorkspaceCommit, WorkspaceCommitError } from './storage/commit-policy.js';
import type { MetaRow } from './storage/records.js';
import type { CommitOptions, CommitOutcome } from './session-writer.js';
export { downloadSession } from './downloads.js';
/** Guest adapter. No cloud parser, reader index or synchronization side effect. */
export class WorkspaceRepository extends WorkspaceDatabase {
  constructor(factory: IDBFactory = globalThis.indexedDB, namespace = 'endless-workspace') {
    if (namespace !== 'endless-workspace')
      throw new Error('游客仓库不能打开云副本或其他命名空间');
    super(factory, namespace);
  }
  async commit(next: Workspace, options: CommitOptions = {}): Promise<CommitOutcome> {
    const db = await this.db(), rows = this.rows(next);
    return new Promise((resolve, reject) => {
      // Reserved v2 stores remain intact. Unexpected rows block writes without interpreting cloud contracts.
      const extra = ['outbox', 'eventIds', 'sync'];
      const tx = db.transaction(['meta', 'revisions', 'branches', 'objects', 'staging', ...extra], 'readwrite');
      let remaining = 4 + extra.length, error = '保存失败，请检查可用空间后重试。本次操作尚未提交';
      const held: {
        meta?: MetaRow;
        revisions: unknown[];
        branches: unknown[];
        objects: Record<string, unknown>[];
      } = { revisions: [], branches: [], objects: [] };
      let occupied = false;
      const done = () => {
        if (--remaining)
          return;
        try {
          if (occupied)
            throw new WorkspaceCommitError('游客库含未识别的附加记录，原件保留，不能提交');
          assertWorkspaceCommit(held, next, options);
          for (const name of ['revisions', 'branches', 'objects'] as const) {
            const store = tx.objectStore(name);
            store.clear();
            for (const row of rows[name])
              store.put(row, row.id);
          }
          tx.objectStore('meta').put({ ...rows.meta, management: rows.management }, 'workspace');
        }
        catch (cause) {
          error = cause instanceof WorkspaceCommitError ? cause.message : error;
          tx.abort();
        }
      };
      const meta = tx.objectStore('meta').get('workspace');
      meta.onsuccess = () => { held.meta = meta.result; done(); };
      for (const name of ['revisions', 'branches', 'objects'] as const) {
        const request = tx.objectStore(name).getAll();
        request.onsuccess = () => { held[name] = request.result; done(); };
      }
      for (const name of extra) {
        const request = tx.objectStore(name).count();
        request.onsuccess = () => { occupied ||= request.result > 0; done(); };
      }
      tx.oncomplete = () => resolve({ enqueued: 0, replaced: [] });
      tx.onabort = tx.onerror = () => reject(new Error(error));
    });
  }
}
