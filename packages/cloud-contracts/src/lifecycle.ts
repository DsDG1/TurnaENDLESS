import { z } from 'zod';
import { UuidSchema } from './envelope.js';
import { MetadataContentIdSchema } from './metadata.js';
const Version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
export const LifecycleValueSchema = z.object({
  lifecycle: z.enum(['active', 'trashed']), trashedAt: z.string().datetime().nullable(),
  archiveVolumeId: z.string().regex(/^vol_[0-9a-f-]{36}$/).nullable(),
}).strict().refine((v) => (v.lifecycle === 'trashed') === (v.trashedAt !== null));
export const LifecycleEntrySchema = z.object({
  contentId: MetadataContentIdSchema, sourceKind: z.enum(['bundled', 'generated']),
  version: Version, value: LifecycleValueSchema, updatedAt: z.string().datetime(),
}).strict();
export type LifecycleEntry = z.infer<typeof LifecycleEntrySchema>;
export const LifecycleCommandSchema = z.object({
  workspaceId: UuidSchema, commandId: UuidSchema, contentId: MetadataContentIdSchema,
  baseVersion: Version, type: z.enum(['trash', 'restore']),
}).strict();
export type LifecycleCommand = z.infer<typeof LifecycleCommandSchema>;
export const LifecycleReceiptSchema = z.object({
  workspaceId: UuidSchema, commandId: UuidSchema, outcome: z.enum(['applied', 'conflict']), entry: LifecycleEntrySchema,
}).strict();
export type LifecycleReceipt = z.infer<typeof LifecycleReceiptSchema>;
