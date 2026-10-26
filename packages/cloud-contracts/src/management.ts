import { z } from 'zod';
import { UuidSchema, CLOUD_LIMITS } from './envelope.js';
import { MetadataEntrySchema } from './metadata.js';
import { LifecycleEntrySchema, LifecycleCommandSchema, LifecycleReceiptSchema } from './lifecycle.js';
import { ArchiveSnapshotSchema } from './archives.js';
import { RevisionRegistrationSchema, RevisionCatalogSchema } from './revisions.js';
export * from './lifecycle.js';

const Version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
export const ManagementChangeSchema = z.discriminatedUnion('type', [
  z.object({ seq: z.number().int().positive(), type: z.literal('display'), entry: MetadataEntrySchema }).strict(),
  z.object({ seq: z.number().int().positive(), type: z.literal('lifecycle'), entry: LifecycleEntrySchema }).strict(),
  z.object({ seq: z.number().int().positive(), type: z.literal('archive'), snapshot: ArchiveSnapshotSchema }).strict(),
  z.object({ seq: z.number().int().positive(), type: z.literal('revision'), registration: RevisionRegistrationSchema }).strict(),
]);
export type ManagementChange = z.infer<typeof ManagementChangeSchema>;
export const ManagementBootstrapSchema = z.object({
  workspaceId: UuidSchema, cursor: z.string().min(1).max(512),
  changeSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  display: z.array(MetadataEntrySchema).max(2000),
  lifecycle: z.array(LifecycleEntrySchema).max(2000),
  archive: ArchiveSnapshotSchema.shape.state.optional(),
  archiveOrigin: ArchiveSnapshotSchema.shape.state.shape.volumes.optional(),
  revisionCatalog: RevisionCatalogSchema.optional(),
}).strict().refine((v) => new Set(v.display.map((e) => e.contentId)).size === v.display.length
  && new Set(v.lifecycle.map((e) => e.contentId)).size === v.lifecycle.length);
export type ManagementBootstrap = z.infer<typeof ManagementBootstrapSchema>;
export const ManagementPullSchema = z.object({
  workspaceId: UuidSchema, fromCursor: z.string().min(1).max(512), nextCursor: z.string().min(1).max(512),
  changes: z.array(ManagementChangeSchema).max(CLOUD_LIMITS.listPageMax), hasMore: z.boolean(),
}).strict();
export type ManagementPull = z.infer<typeof ManagementPullSchema>;
export const LifecycleStateSchema = z.object({
  format: z.literal('lifecycle-outbox/1'),
  cursor: z.string().min(1).max(512).nullable(),
  changeSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  known: z.record(z.string(), LifecycleEntrySchema),
  pending: z.record(z.string(), z.object({ request: LifecycleCommandSchema, conflict: LifecycleReceiptSchema.optional() }).strict()),
}).strict().superRefine((state, ctx) => {
  for (const [id, entry] of Object.entries(state.known)) if (id !== entry.contentId) ctx.addIssue({ code: 'custom', message: '生命周期身份不一致' });
  for (const [id, entry] of Object.entries(state.pending)) {
    const conflict = entry.conflict;
    if (id !== entry.request.contentId || (conflict && (conflict.entry.contentId !== id || conflict.commandId !== entry.request.commandId
      || conflict.workspaceId !== entry.request.workspaceId || conflict.outcome !== 'conflict'))) ctx.addIssue({ code: 'custom', message: '生命周期命令身份不一致' });
  }
});
export type LifecycleState = z.infer<typeof LifecycleStateSchema>;
