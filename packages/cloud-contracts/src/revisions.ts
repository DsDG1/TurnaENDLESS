import { z } from 'zod';
import { UuidSchema } from './envelope.js';
import { ObjectDigestSchema } from './objects.js';
import { SyncBranchManifestSchema } from './sync.js';
import { MetadataEntrySchema } from './metadata.js';
import { SyncStreamBindingSchema } from './sync.js';

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

export const RevisionArtifactSchema = RevisionPreviewReceiptSchema.options[0].shape.artifact;
/** Confirmation names an immutable preview; clients cannot replace its draft, identities or result. */
export const RevisionAdoptionCommandSchema = z.object({
  protocol: z.literal('cloud-revision-adoption/1'), workspaceId: UuidSchema,
  commandId: UuidSchema, previewRequestId: UuidSchema, artifactDigest: ObjectDigestSchema,
}).strict();
export type RevisionAdoptionCommand = z.infer<typeof RevisionAdoptionCommandSchema>;
export const RevisionRegistrationSchema = z.object({
  format: z.literal('cloud-revision-registration/1'), version: Version.positive(),
  readingChangeSeq: Version,
  commandId: UuidSchema, previewRequestId: UuidSchema,
  artifact: RevisionArtifactSchema,
  entry: z.object({ contentId: Ref('ent'), revisionIds: z.array(Ref('rev')).min(1).max(64),
    headRevisionId: Ref('rev'), updatedAt: z.string().datetime() }).strict(),
  obligations: z.array(z.object({ contentId: Ref('ent'), revisionId: Ref('rev'),
    createdAt: z.string().datetime(), waivedAt: z.string().datetime().nullable() }).strict()).max(500),
  display: MetadataEntrySchema, stream: SyncStreamBindingSchema,
  prefixEventIds: z.array(UuidSchema).max(10_000).optional(),
  /** New registrations bind the complete reading inventory at adoption. Old records stay byte-for-byte legacy. */
  readingContext: z.object({ format: z.literal('cloud-revision-reading-context/1'),
    heads: z.array(SyncStreamBindingSchema).min(1).max(64),
  }).strict().optional(),
}).strict();
export type RevisionRegistration = z.infer<typeof RevisionRegistrationSchema>;
export const RevisionCatalogSchema = z.object({
  workspaceId: UuidSchema, version: Version,
  registrations: z.array(RevisionRegistrationSchema).max(64), digest: ObjectDigestSchema,
}).strict();
export type RevisionCatalog = z.infer<typeof RevisionCatalogSchema>;
export const RevisionAdoptionReceiptSchema = z.discriminatedUnion('outcome', [
  z.object({ workspaceId: UuidSchema, commandId: UuidSchema, outcome: z.literal('applied'), registration: RevisionRegistrationSchema }).strict(),
  z.object({ workspaceId: UuidSchema, commandId: UuidSchema, outcome: z.literal('conflict'), reason: z.literal('precondition') }).strict(),
  z.object({ workspaceId: UuidSchema, commandId: UuidSchema, outcome: z.literal('rejected'), reason: z.enum(['content', 'history', 'capacity', 'members']) }).strict(),
]);
export type RevisionAdoptionReceipt = z.infer<typeof RevisionAdoptionReceiptSchema>;
export const RevisionOutboxSchema = z.object({
  format: z.literal('revision-outbox/1'),
  installed: z.array(RevisionRegistrationSchema).max(64),
  pending: z.object({ request: RevisionPreviewRequestSchema, baseline: z.unknown(),
    preview: RevisionPreviewReceiptSchema.optional(), confirmation: RevisionAdoptionCommandSchema.optional(),
    result: RevisionAdoptionReceiptSchema.optional() }).strict().nullable(),
}).strict();
export type RevisionOutbox = z.infer<typeof RevisionOutboxSchema>;
