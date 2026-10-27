import { z } from 'zod';
import { UuidSchema } from './envelope.js';
import { ObjectDigestSchema } from './objects.js';
import { SyncRecoveryRequestSchema, SyncStreamBindingSchema, SyncStreamHistorySchema } from './sync.js';
import { RevisionCatalogSchema } from './revisions.js';

/** A read-only recovery request never supplies replacement content or claimed snapshot bodies. */
export const ReadingSnapshotRequestSchema = z.object({
  workspaceId: SyncRecoveryRequestSchema.shape.workspaceId,
  cloudVersion: SyncRecoveryRequestSchema.shape.cloudVersion,
  streams: z.array(SyncStreamBindingSchema).max(64),
}).strict().superRefine((v, ctx) => {
  if (new Set(v.streams.map((s) => s.streamId)).size !== v.streams.length
    || v.streams.some((s) => s.branchId !== s.streamId || (s.eventSeq === 0) !== (s.lastEventId === null))) {
    ctx.addIssue({ code: 'custom', message: '恢复前缀身份无效' });
  }
});
export type ReadingSnapshotRequest = z.infer<typeof ReadingSnapshotRequestSchema>;

/** One bounded, lock-consistent cut. Subsequent pulls start after changeSeq, even after feed pruning. */
export const ReadingSnapshotSchema = z.object({
  format: z.literal('cloud-reading-snapshot/1'), workspaceId: UuidSchema,
  cloudVersion: z.string().regex(/^\d+$/).max(20),
  changeSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  cursor: z.string().min(1).max(512),
  source: z.unknown(), sourceDigest: ObjectDigestSchema,
  histories: z.array(SyncStreamHistorySchema).min(1).max(64),
  revisionCatalog: RevisionCatalogSchema,
  digest: ObjectDigestSchema,
}).strict();
export type ReadingSnapshot = z.infer<typeof ReadingSnapshotSchema>;
