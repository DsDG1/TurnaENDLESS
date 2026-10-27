import type { CommitOptions } from '../session-writer.js';
import type { ResolveConflictResponse } from '@endless/cloud-contracts';
import type { PendingPreservation } from './conflict.js';

/** Synchronization options belong to the cloud adapter, never to the native writer. */
export interface CloudCommitOptions extends CommitOptions {
  remote?: { streamId: string; startSeq: number; eventIds: readonly string[]; prefixStreamId?: string };
  preservation?: { plan: PendingPreservation; result: ResolveConflictResponse };
}
