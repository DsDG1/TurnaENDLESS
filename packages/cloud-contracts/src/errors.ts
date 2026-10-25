import { z } from 'zod';

/**
 * 云 API 安全错误契约（计划 §14.2）。
 * 信封只携带可对外暴露的分类、稳定码与关联 ID；供应商响应体、
 * 提示词、内部堆栈和秘密绝不进入该结构。
 */

export const CloudErrorCategorySchema = z.enum([
  'auth', 'permission', 'contract', 'sync', 'generation',
  'capacity', 'storage', 'payment', 'rate-limit', 'internal',
]);
export type CloudErrorCategory = z.infer<typeof CloudErrorCategorySchema>;

/** 稳定错误码；客户端只依赖 code，不解析文案。 */
export const CloudErrorCodeSchema = z.enum([
  'BAD_REQUEST',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'RATE_LIMITED',
  'INTERNAL',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'UNSUPPORTED_CONTRACT',
  'SYNC_CONFLICT',
  'IDEMPOTENCY_MISMATCH',
  'IDEMPOTENCY_IN_PROGRESS',
  'CURSOR_EXPIRED',
  'QUOTE_EXPIRED',
  'BASIS_CHANGED',
  'INSUFFICIENT_CREDITS',
  'ACCOUNT_BUSY',
  'PROVIDER_CALL_UNCERTAIN',
  'PLATFORM_CAPACITY',
  'CONTENT_REJECTED',
  'PROVIDER_AUTH',
  'PROVIDER_RATE_LIMIT',
  'PROVIDER_TIMEOUT',
  'STORAGE_UNAVAILABLE',
  'STORAGE_QUOTA',
  'PAYMENT_PENDING',
]);
export type CloudErrorCode = z.infer<typeof CloudErrorCodeSchema>;

/**
 * retryAction 明确区分语义，避免「retryable=true」诱发自动付费重试：
 * - retry_read：幂等读取可重试；
 * - resume_same_request：沿用原 requestId 恢复同一任务/提交；
 * - resolve_conflict：需显式解决冲突后才能继续；
 * - manual_new_generation：只能由用户显式发起一次新报价/生成；
 * - contact_support：需要人工/客服路径，自动重试没有意义。
 */
export const CloudRetryActionSchema = z.enum([
  'retry_read', 'resume_same_request', 'resolve_conflict',
  'manual_new_generation', 'contact_support',
]);
export type CloudRetryAction = z.infer<typeof CloudRetryActionSchema>;

export const CloudErrorBodySchema = z.object({
  error: z.object({
    code: CloudErrorCodeSchema,
    category: CloudErrorCategorySchema,
    safeMessage: z.string().min(1).max(500),
    correlationId: z.string().min(8).max(64),
    retryAction: CloudRetryActionSchema.optional(),
    jobId: z.string().optional(),
    conflictId: z.string().optional(),
    retryAfter: z.number().int().nonnegative().optional(),
  }),
});
export type CloudErrorBody = z.infer<typeof CloudErrorBodySchema>;
