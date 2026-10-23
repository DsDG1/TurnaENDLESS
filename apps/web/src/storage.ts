import type { PlayerSession } from '@endless/player';
import type { GenerationRequest, SavedPlayer } from '@endless/content';

export class SessionRepository {
  private database: Promise<IDBDatabase>;

  constructor(factory: IDBFactory = globalThis.indexedDB) {
    this.database = new Promise((resolve, reject) => {
      if (!factory) {
        reject(new Error('当前浏览器无法使用本地存储，请使用普通模式的 Edge 或 Chrome'));
        return;
      }
      const request = factory.open('endless-player', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('sessions');
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(new Error('无法打开本地存档，请检查浏览器存储权限'));
      request.onblocked = () => reject(new Error('存档正在被其他窗口使用，请关闭旧窗口后重试'));
    });
  }

  async load(key = 'current'): Promise<unknown> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('sessions', 'readonly');
      const request = transaction.objectStore('sessions').get(key);
      transaction.oncomplete = () => resolve(request.result ?? null);
      transaction.onabort = () => reject(new Error('读取本地存档失败，已有数据未被修改'));
      transaction.onerror = () => reject(new Error('读取本地存档失败，已有数据未被修改'));
    });
  }

  async save(session: PlayerSession | SavedPlayer, previousRevision: number, completedRequestId?: string): Promise<void> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('sessions', 'readwrite');
      const store = transaction.objectStore('sessions');
      let error = '保存失败，请检查可用空间后重试。本次操作尚未提交';
      const request = store.get('current');
      request.onsuccess = () => {
        const stored = request.result as { revision?: unknown } | undefined;
        if ((stored?.revision ?? 0) !== previousRevision) {
          error = '另一个窗口已更新进度，请刷新后继续，避免覆盖已有记录';
          transaction.abort();
          return;
        }
        const generation = store.get('generation');
        generation.onsuccess = () => {
          const pending = generation.result as GenerationRequest | undefined;
          if ((pending && pending.requestId !== completedRequestId) || (!pending && completedRequestId)) {
            error = '生成任务正在其他窗口等待，或已被取消。请刷新后继续，避免覆盖内容';
            transaction.abort();
            return;
          }
          store.put(session, 'current');
          if (completedRequestId) store.delete('generation');
        };
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(new Error(error));
      transaction.onerror = () => reject(new Error(error));
    });
  }

  async reserveGeneration(input: GenerationRequest): Promise<GenerationRequest> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('sessions', 'readwrite');
      const store = transaction.objectStore('sessions');
      let error = '无法保存生成任务，尚未调用模型';
      let reserved = input;
      const request = store.get('current');
      request.onsuccess = () => {
        const stored = request.result as { revision?: unknown } | undefined;
        if ((stored?.revision ?? 0) !== input.save.revision) {
          error = '另一个窗口已更新进度，请刷新后生成';
          transaction.abort();
          return;
        }
        const pending = store.get('generation');
        pending.onsuccess = () => {
          if (pending.result && (pending.result as GenerationRequest).requestId !== input.requestId) {
            error = '另一个窗口已有生成任务，请刷新后恢复该任务';
            transaction.abort();
            return;
          }
          if (pending.result) {
            reserved = pending.result as GenerationRequest;
            return;
          }
          const revision = input.save.revision + 1;
          reserved = { ...input, save: { ...input.save, revision, session: { ...input.save.session, revision } } };
          store.put(reserved.save, 'current');
          store.put(reserved, 'generation');
        };
      };
      transaction.oncomplete = () => resolve(reserved);
      transaction.onabort = () => reject(new Error(error));
      transaction.onerror = () => reject(new Error(error));
    });
  }

  async clearGeneration(requestId: string): Promise<void> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('sessions', 'readwrite');
      const store = transaction.objectStore('sessions');
      const request = store.get('generation');
      request.onsuccess = () => {
        if ((request.result as GenerationRequest | undefined)?.requestId === requestId) store.delete('generation');
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(new Error('无法结束本地生成等待，请刷新重试'));
      transaction.onerror = () => reject(new Error('无法结束本地生成等待，请刷新重试'));
    });
  }

  async close(): Promise<void> {
    (await this.database).close();
  }
}

export function downloadSession(value: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `endless-progress-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
