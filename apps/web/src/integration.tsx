import type { ReactNode, ComponentProps } from 'react';
import type { Player } from './player-model.js';
import { usePlayer } from './use-player.js';
import { parseLocalRoute, type AppRoute, type CloudTarget, type Page } from './navigation.js';
import type { CloudReadBanner as ConnectedBanner } from './cloud/reader.js';

/** Default composition root. Cloud implementation is selected only by the explicit cloud build. */
export const cloudEnabled = false;
export const parseRoute = parseLocalRoute;
export type { AppRoute, Page } from './navigation.js';
export function cloudHash(_target: CloudTarget, _page?: Page): string { return 'cloud'; }
export function LocalPlayerScope({ children }: { children(player: Player): ReactNode }) {
  const player = usePlayer();
  return children(player);
}
export function PlayerScope({ children }: { route: AppRoute; children(player: Player): ReactNode }) {
  return <LocalPlayerScope>{children}</LocalPlayerScope>;
}
export function CloudReadBanner(_props: ComponentProps<typeof ConnectedBanner>) { return null; }
export function CloudRoute(_props: { backup(): unknown | null }) {
  return <section className="surface"><h1>此版本提供本机阅读</h1><p>云端副本请使用独立的云研发版本。本机内容和离线进度保留。</p><a href="#home">返回故事频道</a></section>;
}
