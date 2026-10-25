import { z } from 'zod';

/**
 * `/api/cloud/v1` 网络信封共享约定（计划 §14）。
 * 本包只放 API、Worker、Web 三方真正共享的网络契约；不放服务端秘密、
 * 不放数据库行形状、不放内容领域规则。
 */

export const CLOUD_API_PREFIX = '/api/cloud/v1' as const;
export const CLOUD_PROTOCOL_VERSION = 'endless-cloud/1' as const;

/** 幂等键请求头（§5.3：account+operation+key 唯一；异摘要 409）。 */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key' as const;
/** 关联 ID：客户端可传，服务端始终回写响应头与错误信封。 */
export const CORRELATION_HEADER = 'x-endless-correlation-id' as const;
/** 本机页面 Key 在本服务上永远被拒绝（§2.4），避免误转发凭据到云端。 */
export const LEGACY_PROVIDER_KEY_HEADER = 'x-endless-provider-key' as const;

export const IdempotencyKeySchema = z.string().min(8).max(128).regex(/^[\x21-\x7e]+$/, 'Idempotency-Key 必须为可打印 ASCII');

export const UuidSchema = z.string().uuid();

/** 初始资源边界（§14.3 初值；非性能承诺）。 */
export const CLOUD_LIMITS = {
  controlBodyBytes: 1_048_576,
  uploadObjectBytes: 2_097_152,
  eventsPerBatch: 256,
  listPageDefault: 50,
  listPageMax: 100,
  quoteTtlSeconds: 300,
  queueSeconds: 300,
} as const;
