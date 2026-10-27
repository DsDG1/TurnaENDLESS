import type { usePlayer } from './use-player.js';
import type { useCloudPlayer } from './cloud/use-player.js';

/** Presentation-only union. Type imports erase; neither reader hook imports the other. */
export type Player = ReturnType<typeof usePlayer> | ReturnType<typeof useCloudPlayer>;
