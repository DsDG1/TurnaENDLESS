/** UI destinations and scope only; no account protocol or storage adapter. */
export const PAGES = ['home', 'watch', 'progress', 'library', 'edition', 'settings', 'cloud'] as const;
export type Page = typeof PAGES[number];
export interface CloudTarget {
  deploymentId: string;
  accountId: string;
  workspaceId: string;
  namespace: string;
}
export type AppRoute = { shell: 'local'; page: Page } | { shell: 'cloud'; page: Page; target: CloudTarget };

export function parseLocalRoute(hash: string): AppRoute {
  const page = hash.replace(/^#/, '').split('/').filter(Boolean)[0];
  if (page === 'cloud-read' || page === 'cloud') return { shell: 'local', page: 'cloud' };
  return { shell: 'local', page: PAGES.includes(page as Page) ? page as Page : 'home' };
}
