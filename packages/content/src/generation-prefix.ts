/** Native generation planning shared by local and optional cloud adapters. */
import { projectSession, type Library, type PlayerSession } from '@endless/player';
import type { Content } from './index.js';

export interface VerifiedPrefix {
  source: 'local-saved-player' | 'cloud-history';
  session: PlayerSession;
  library: Library;
  /** The original planning instant, stored as generatedAt in legacy envelopes. */
  plannedAt: string;
  completePrefix: true;
}

export function localVerifiedPrefix(session: PlayerSession, library: Library, plannedAt: string): VerifiedPrefix {
  projectSession(session, library);
  return { source: 'local-saved-player', session, library, plannedAt, completePrefix: true };
}

export function planAtFrozenTime(content: Content, prefix: VerifiedPrefix) {
  return content.planCreative(prefix.session, prefix.library, new Date(prefix.plannedAt));
}

/** Preserve the meaning of existing generatedAt fields; never reinterpret stored documents. */
export function legacyEnvelopeGeneratedAt(plannedAt: string): string {
  return plannedAt;
}
