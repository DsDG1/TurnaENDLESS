import { z } from 'zod';
import { CLOUD_LIMITS, UuidSchema } from './envelope.js';

const ObjectIdSchema = UuidSchema.toLowerCase();
export const ObjectDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const ObjectSizeSchema = z.number().int().min(1).max(CLOUD_LIMITS.uploadObjectBytes);
export const ObjectManifestSchema = z.object({
  format: z.literal('endless-object-manifest'),
  version: z.literal(1),
  objects: z.array(z.object({
    id: ObjectIdSchema,
    digest: ObjectDigestSchema,
    size: ObjectSizeSchema,
  }).strict()).max(256),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.objects.map((entry) => entry.id)).size !== value.objects.length) {
    ctx.addIssue({ code: 'custom', path: ['objects'], message: '对象引用不可重复' });
  }
});
export type ObjectManifest = z.infer<typeof ObjectManifestSchema>;

export const PrepareObjectRequestSchema = z.object({
  id: ObjectIdSchema,
  workspaceId: ObjectIdSchema,
  domainId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/),
  contract: z.enum(['endless-object-manifest/1', 'endless-backup/1']),
  digest: ObjectDigestSchema,
  size: ObjectSizeSchema,
}).strict();
export type PrepareObjectRequest = z.infer<typeof PrepareObjectRequestSchema>;

export const CloudObjectSchema = PrepareObjectRequestSchema.extend({
  digestAlgorithm: z.literal('sha256-bytes/1'),
  status: z.enum(['staging', 'verified', 'committed']),
  uploadExpiresAt: z.string().datetime(),
  retainUntil: z.string().datetime(),
});
export type CloudObject = z.infer<typeof CloudObjectSchema>;

export const ObjectResponseSchema = z.object({ object: CloudObjectSchema });
export const PrepareObjectResponseSchema = ObjectResponseSchema.extend({
  upload: z.object({ method: z.literal('PUT'), path: z.string().startsWith('/api/cloud/v1/objects/') }),
});
export const ObjectDownloadResponseSchema = z.object({
  url: z.url(),
  expiresAt: z.string().datetime(),
  digest: ObjectDigestSchema,
  size: ObjectSizeSchema,
});
export const ObjectUsageResponseSchema = z.object({
  limitBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  stagingBytes: z.number().int().nonnegative(),
  verifiedBytes: z.number().int().nonnegative(),
  committedBytes: z.number().int().nonnegative(),
  objectCount: z.number().int().nonnegative(),
});
