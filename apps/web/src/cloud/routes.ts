import { UuidSchema } from '@endless/cloud-contracts';
import { cloudNamespace } from './local.js';
import { PAGES, type Page, type AppRoute, type CloudTarget } from '../navigation.js';
export { PAGES, type Page, type AppRoute, type CloudTarget } from '../navigation.js';

/**
 * 路由解析（纯函数）。云阅读使用深链：
 *   `#cloud-read/<deployment>/<account>/<workspace>[/<page>]`
 *
 * 把三个 ID 都放在链接里，是因为云库命名空间由「部署 + 账号 + 工作区」共同决定：
 * 不额外写一份「最近打开的副本」指针，就不会出现指针指向已被清理的库时静默失败。
 * 刷新、书签、另开标签都能重新落到同一个副本。
 */


/** Cloud library exposes only the implemented display and recycle commands. */
export const CLOUD_PAGES = ['home', 'watch', 'progress', 'library'] as const;

const asPage = (value: string | undefined): Page | null =>
  value && (PAGES as readonly string[]).includes(value) ? value as Page : null;

export function parseRoute(hash: string): AppRoute {
  const parts = hash.replace(/^#/, '').replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts[0] !== 'cloud-read') return { shell: 'local', page: asPage(parts[0]) ?? 'home' };
  const ids = parts.slice(1, 4);
  if (ids.length !== 3 || !ids.every((id) => UuidSchema.safeParse(id).success)) {
    // 坏链接不猜：回到云端页说明情况，而不是假装打开了某个副本
    return { shell: 'local', page: 'cloud' };
  }
  const [deploymentId, accountId, workspaceId] = ids as [string, string, string];
  const requested = parts[4];
  return {
    shell: 'cloud',
    page: requested && (CLOUD_PAGES as readonly string[]).includes(requested) ? requested as Page : 'home',
    target: {
      deploymentId, accountId, workspaceId,
      namespace: cloudNamespace(deploymentId, accountId, workspaceId),
    },
  };
}

/** 生成深链（不含 `#`）。云副本里非阅读页一律回落到首页。 */
export function cloudHash(
  target: Pick<CloudTarget, 'deploymentId' | 'accountId' | 'workspaceId'>,
  page: Page = 'home',
): string {
  const base = `cloud-read/${target.deploymentId}/${target.accountId}/${target.workspaceId}`;
  return (CLOUD_PAGES as readonly string[]).includes(page) && page !== 'home' ? `${base}/${page}` : base;
}
