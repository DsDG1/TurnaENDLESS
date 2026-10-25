import { z } from 'zod';
import { UuidSchema } from './envelope.js';
import { ObjectDigestSchema, ObjectSizeSchema } from './objects.js';

export const ImportCountsSchema = z.object({
  entries: z.number().int().nonnegative(), revisions: z.number().int().nonnegative(),
  branches: z.number().int().nonnegative(), volumes: z.number().int().nonnegative(),
  checkpoints: z.number().int().nonnegative(), tickets: z.number().int().nonnegative(),
  management: z.number().int().nonnegative(),
}).strict();

export const CloudImportPreviewSchema = z.object({
  id: UuidSchema,
  workspaceId: UuidSchema,
  sourceLocalId: z.string().min(1).max(128),
  sourceProfileId: z.string().min(1).max(128),
  sourceRepositoryRevision: z.number().int().nonnegative(),
  sourceDigest: ObjectDigestSchema,
  snapshotDigest: ObjectDigestSchema,
  objectId: UuidSchema,
  size: ObjectSizeSchema,
  counts: ImportCountsSchema,
  eventCount: z.number().int().nonnegative(),
  pendingLocalTickets: z.number().int().nonnegative(),
  sourceKinds: z.array(z.enum(['bundled', 'generated'])).max(2),
  relationship: z.enum(['new', 'empty-workspace', 'same-import']),
  state: z.enum(['ready', 'activated']),
  validationBinding: ObjectDigestSchema,
  copyPolicy: z.literal('endless-cloud-copy/1'),
  expiresAt: z.string().datetime(),
}).strict();
export type CloudImportPreview = z.infer<typeof CloudImportPreviewSchema>;
export const CloudImportPreviewResponseSchema = z.object({ preview: CloudImportPreviewSchema });

export const ActivateImportRequestSchema = z.object({
  previewId: UuidSchema,
  snapshotDigest: ObjectDigestSchema,
  validationBinding: ObjectDigestSchema,
}).strict();
export type ActivateImportRequest = z.infer<typeof ActivateImportRequestSchema>;

export const CloudImportReceiptSchema = z.object({
  id: UuidSchema,
  workspaceId: UuidSchema,
  sourceLocalId: z.string().min(1).max(128),
  sourceProfileId: z.string().min(1).max(128),
  sourceRepositoryRevision: z.number().int().nonnegative(),
  sourceObjectId: UuidSchema,
  sourceDigest: ObjectDigestSchema,
  snapshotDigest: ObjectDigestSchema,
  copyDigest: ObjectDigestSchema,
  copyCreatedAt: z.string().datetime(),
  validationBinding: ObjectDigestSchema,
  copyPolicy: z.literal('endless-cloud-copy/1'),
  contentIds: z.array(z.string().min(1)).max(500),
  revisionIds: z.array(z.string().min(1)).max(64),
  seedContentIds: z.array(z.string().min(1)).length(3),
}).strict();
export type CloudImportReceipt = z.infer<typeof CloudImportReceiptSchema>;
export const CloudImportResponseSchema = z.object({ receipt: CloudImportReceiptSchema });
export const CloudPackageResponseSchema = z.object({ receipt: CloudImportReceiptSchema, workspace: z.unknown() });

export const InstallWorkspaceRequestSchema = z.object({
  importId: UuidSchema,
  copyDigest: ObjectDigestSchema,
}).strict();
export type InstallWorkspaceRequest = z.infer<typeof InstallWorkspaceRequestSchema>;

export const WorkspaceInstallationSchema = z.object({
  id: UuidSchema, workspaceId: UuidSchema, importId: UuidSchema, deviceId: UuidSchema,
  copyDigest: ObjectDigestSchema, installedAt: z.string().datetime(),
}).strict();
export type WorkspaceInstallation = z.infer<typeof WorkspaceInstallationSchema>;
export const WorkspaceInstallationResponseSchema = z.object({ installation: WorkspaceInstallationSchema });
