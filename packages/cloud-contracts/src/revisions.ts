import { z } from 'zod';
import { UuidSchema } from './envelope.js';
import { ObjectDigestSchema } from './objects.js';
import { SyncBranchManifestSchema } from './sync.js';

const Ref = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`));
const Version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
/** A draft is data. No executable batch, claimed basis, time or client-assigned result identities. */
export const RevisionPreviewRequestSchema = z.object({
  workspaceId: UuidSchema, requestId: UuidSchema,
  streamId: Ref('brn'), contentId: Ref('ent'), baseRevisionId: Ref('rev'),
  baseSeq: z.number().int().nonnegative().max(10_000), baseEventId: UuidSchema.nullable(),
  displayVersion: Version, lifecycleVersion: Version, archiveVersion: Version,
  draft: z.string().min(1).max(120_000),
}).strict().refine((v) => (v.baseSeq === 0) === (v.baseEventId === null), '流头身份与计数不一致');
export type RevisionPreviewRequest = z.infer<typeof RevisionPreviewRequestSchema>;

export const RevisionPreviewBindingSchema = z.object({
  sourceDigest: ObjectDigestSchema, inventoryDigest: ObjectDigestSchema,
  streamId: Ref('brn'), baseRevisionId: Ref('rev'),
  eventCount: z.number().int().nonnegative().max(10_000), lastEventId: UuidSchema.nullable(),
  displayVersion: Version, lifecycleVersion: Version, archiveVersion: Version,
}).strict();
const Common = {
  workspaceId: UuidSchema, requestId: UuidSchema,
  // A successful preview is never permission to activate content or reinterpret history.
  adoptionAvailable: z.literal(false),
};
export const RevisionPreviewReceiptSchema = z.discriminatedUnion('outcome', [
  z.object({ ...Common, outcome: z.literal('ready'),
    artifact: z.object({
      compiler: z.literal('cloud-revision-preview/1'),
      mode: z.enum(['in-place', 'fork']), binding: RevisionPreviewBindingSchema,
      revision: z.unknown(), revisionDigest: ObjectDigestSchema,
      branch: SyncBranchManifestSchema, digest: ObjectDigestSchema,
    }).strict(),
  }).strict(),
  z.object({ ...Common, outcome: z.literal('conflict'), reason: z.literal('precondition') }).strict(),
  z.object({ ...Common, outcome: z.literal('rejected'), reason: z.enum(['content', 'history', 'capacity', 'members']) }).strict(),
]);
export type RevisionPreviewReceipt = z.infer<typeof RevisionPreviewReceiptSchema>;
