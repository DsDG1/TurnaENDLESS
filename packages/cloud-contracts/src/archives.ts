import { z } from 'zod';
import { UuidSchema } from './envelope.js';
import { MetadataContentIdSchema, MetadataEntrySchema } from './metadata.js';
import { LifecycleEntrySchema } from './lifecycle.js';

export const ArchiveIdSchema = z.string().regex(/^vol_[0-9a-f-]{36}$/);
const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
const members = z.array(z.object({
  contentId: MetadataContentIdSchema, revisionId: z.string().regex(/^rev_[0-9a-f-]{36}$/),
  lifecycleVersion: version, displayVersion: version,
}).strict()).min(1).max(500);
const common = { workspaceId: UuidSchema, commandId: UuidSchema, volumeId: ArchiveIdSchema, baseVersion: version, members };
export const ArchiveCommandSchema = z.discriminatedUnion('type', [
  z.object({ ...common, type: z.literal('archive'), title: z.string().trim().min(1).max(100),
    basis: z.object({ streamId: z.string().regex(/^brn_[0-9a-f-]{36}$/), eventCount: z.number().int().nonnegative().max(10_000),
      eventHash: z.string().regex(/^[a-f0-9]{16}$/) }).strict(),
  }).strict(),
  z.object({ ...common, type: z.literal('unarchive') }).strict(),
]).refine((v) => new Set(v.members.map((m) => m.contentId)).size === v.members.length);
export type ArchiveCommand = z.infer<typeof ArchiveCommandSchema>;
/** Volume bodies are parsed with the existing content-owned ArchiveVolumeSchema at both application boundaries. */
export const ArchiveStateSchema = z.object({ version, volumes: z.array(z.unknown()).max(500) }).strict();
export type ArchiveState = z.infer<typeof ArchiveStateSchema>;
export const ArchiveSnapshotSchema = z.object({
  state: ArchiveStateSchema, lifecycle: z.array(LifecycleEntrySchema).max(2000),
}).strict();
export type ArchiveSnapshot = z.infer<typeof ArchiveSnapshotSchema>;
export const ArchiveReceiptSchema = z.object({
  workspaceId: UuidSchema, commandId: UuidSchema, outcome: z.enum(['applied', 'conflict', 'rejected']),
  reason: z.enum(['precondition', 'basis', 'members', 'capacity']).optional(),
  snapshot: ArchiveSnapshotSchema, display: z.array(MetadataEntrySchema).max(500),
}).strict();
export type ArchiveReceipt = z.infer<typeof ArchiveReceiptSchema>;
export const ArchiveOutboxSchema = z.object({
  format: z.literal('archive-outbox/1'), known: ArchiveStateSchema.nullable(),
  pending: z.object({ request: ArchiveCommandSchema, resolution: ArchiveReceiptSchema.optional() }).strict().nullable(),
}).strict().refine((s) => !s.pending?.resolution || (s.pending.resolution.outcome !== 'applied'
  && s.pending.resolution.commandId === s.pending.request.commandId && s.pending.resolution.workspaceId === s.pending.request.workspaceId));
export type ArchiveOutbox = z.infer<typeof ArchiveOutboxSchema>;
