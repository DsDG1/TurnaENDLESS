import { z } from 'zod';
import { CLOUD_LIMITS, CLOUD_PROTOCOL_VERSION } from './envelope.js';

/**
 * 能力发现（§14.1 GET /capabilities）。
 * 与本机 /api/status 分离：不携带 capability 密钥、不含 provider 配置。
 * features 如实报告已实现能力，未完成能力恒为 false，不得假装可用。
 */
export const CloudCapabilitiesSchema = z.object({
  protocol: z.literal(CLOUD_PROTOCOL_VERSION),
  features: z.object({
    accounts: z.boolean(),
    sessions: z.boolean(),
    devices: z.boolean(),
    workspaces: z.boolean(),
    import: z.boolean(),
    objects: z.boolean(),
    sync: z.boolean(),
    generation: z.boolean(),
    credits: z.boolean(),
    billing: z.boolean(),
    payments: z.boolean(),
    exports: z.boolean(),
    edition: z.boolean(),
  }),
  contracts: z.object({
    workspace: z.string(),
  }),
  limits: z.object({
    controlBodyBytes: z.literal(CLOUD_LIMITS.controlBodyBytes),
    uploadObjectBytes: z.literal(CLOUD_LIMITS.uploadObjectBytes),
    eventsPerBatch: z.literal(CLOUD_LIMITS.eventsPerBatch),
    listPageDefault: z.literal(CLOUD_LIMITS.listPageDefault),
    listPageMax: z.literal(CLOUD_LIMITS.listPageMax),
    quoteTtlSeconds: z.literal(CLOUD_LIMITS.quoteTtlSeconds),
    queueSeconds: z.literal(CLOUD_LIMITS.queueSeconds),
  }),
});
export type CloudCapabilities = z.infer<typeof CloudCapabilitiesSchema>;
