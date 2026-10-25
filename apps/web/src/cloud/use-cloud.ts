import { useEffect, useState, useSyncExternalStore } from 'react';
import { CloudApi } from './client.js';
import { CloudController } from './controller.js';
import { WorkspaceRepository } from '../storage.js';

/**
 * 把云端控制器接到 React：控制器本身不依赖 React，这里只负责实例化、
 * 订阅与首次刷新。SSR/静态渲染时用同一份快照，避免水合前后状态不一致。
 */

const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

export function createCloudController() {
  return new CloudController({
    api: new CloudApi(),
    openRepository: (namespace) => new WorkspaceRepository(globalThis.indexedDB, namespace),
    digest: async (bytes) => hex(await globalThis.crypto.subtle.digest('SHA-256', bytes)),
    key: () => globalThis.crypto.randomUUID(),
  });
}

export function useCloud() {
  const [controller] = useState(createCloudController);
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  useEffect(() => { void controller.refresh(); }, [controller]);
  return { state, controller };
}
