import type { ReactNode } from 'react';
import type { Player } from '../player-model.js';
import type { AppRoute } from '../navigation.js';
import { LocalPlayerScope } from '../integration.js';
import { useCloudPlayer, type CloudPlayerOptions } from './use-player.js';
export { CloudRoute } from './page.js';
export { CloudReadBanner } from './reader.js';
export { parseRoute, cloudHash, type AppRoute, type Page } from './routes.js';
export const cloudEnabled = true;

function CloudPlayerScope({ target, children }: { target: CloudPlayerOptions; children(player: Player): ReactNode }) {
  const player = useCloudPlayer(target);
  return children(player);
}
/** Different scope components remount on route namespace changes; hooks never switch modes in place. */
export function PlayerScope({ route, children }: { route: AppRoute; children(player: Player): ReactNode }) {
  return route.shell === 'cloud'
    ? <CloudPlayerScope target={route.target}>{children}</CloudPlayerScope>
    : <LocalPlayerScope>{children}</LocalPlayerScope>;
}
