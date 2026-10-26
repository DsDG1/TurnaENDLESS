import { z } from 'zod';
import { UuidSchema } from './envelope.js';

/** Display commands have their own versions; device clocks and learning events are not ordering authorities. */
export const MetadataContentIdSchema = z.string().regex(/^ent_[0-9a-f-]{36}$/);
export const EditableMetadataSchema = z.object({
  title: z.string().min(1).max(100),
  tags: z.array(z.string().min(1).max(24)).max(12),
  note: z.string().max(500),
}).strict();
export type EditableMetadata = z.infer<typeof EditableMetadataSchema>;
export const MetadataEntrySchema = z.object({
  contentId: MetadataContentIdSchema,
  version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  value: EditableMetadataSchema,
  updatedAt: z.string().datetime(),
}).strict();
export type MetadataEntry = z.infer<typeof MetadataEntrySchema>;
export const MetadataCommandSchema = z.object({
  workspaceId: UuidSchema, commandId: UuidSchema,
  type: z.literal('set-display'), contentId: MetadataContentIdSchema,
  baseVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  value: EditableMetadataSchema,
}).strict();
export type MetadataCommand = z.infer<typeof MetadataCommandSchema>;
export const MetadataReceiptSchema = z.object({
  workspaceId: UuidSchema, commandId: UuidSchema,
  outcome: z.enum(['applied', 'conflict']), entry: MetadataEntrySchema,
}).strict();
export type MetadataReceipt = z.infer<typeof MetadataReceiptSchema>;
export const MetadataSnapshotSchema = z.object({
  workspaceId: UuidSchema, entries: z.array(MetadataEntrySchema).max(2000),
}).strict().refine((s) => new Set(s.entries.map((e) => e.contentId)).size === s.entries.length);
export type MetadataSnapshot = z.infer<typeof MetadataSnapshotSchema>;

/** Versioned display sidecar stored alongside the client outbox; malformed state is preserved and rejected. */
export const MetadataStateSchema = z.object({
  format: z.literal('metadata-outbox/1'),
  known: z.record(z.string(), MetadataEntrySchema),
  pending: z.record(z.string(), z.object({ request: MetadataCommandSchema, conflict: MetadataReceiptSchema.optional() }).strict()),
}).strict().superRefine((state, ctx) => {
  for (const [id, entry] of Object.entries(state.known)) {
    if (id !== entry.contentId) ctx.addIssue({ code: 'custom', message: '展示信息身份不一致' });
  }
  for (const [id, entry] of Object.entries(state.pending)) {
    if (id !== entry.request.contentId || (entry.conflict && (entry.conflict.commandId !== entry.request.commandId
      || entry.conflict.workspaceId !== entry.request.workspaceId || entry.conflict.entry.contentId !== id
      || entry.conflict.outcome !== 'conflict'))) ctx.addIssue({ code: 'custom', message: '展示信息命令身份不一致' });
  }
});
export type MetadataState = z.infer<typeof MetadataStateSchema>;
