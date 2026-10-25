import type { CloudErrorBody, CloudErrorCategory, CloudErrorCode, CloudRetryAction } from '@endless/cloud-contracts';

/** 服务端安全错误：只携带可外发的分类/码/文案；内部细节走日志关联 ID。 */
export class CloudError extends Error {
  constructor(
    readonly status: number,
    readonly code: CloudErrorCode,
    readonly category: CloudErrorCategory,
    message: string,
    readonly retryAction?: CloudRetryAction,
    readonly extras: { retryAfter?: number; jobId?: string; conflictId?: string } = {},
  ) {
    super(message);
  }

  toBody(correlationId: string): CloudErrorBody {
    return {
      error: {
        code: this.code,
        category: this.category,
        safeMessage: this.message,
        correlationId,
        ...(this.retryAction ? { retryAction: this.retryAction } : {}),
        ...(this.extras.retryAfter !== undefined ? { retryAfter: this.extras.retryAfter } : {}),
        ...(this.extras.jobId ? { jobId: this.extras.jobId } : {}),
        ...(this.extras.conflictId ? { conflictId: this.extras.conflictId } : {}),
      },
    };
  }
}

export const badRequest = (message: string): CloudError =>
  new CloudError(400, 'BAD_REQUEST', 'contract', message);
export const unauthorized = (message = '需要有效会话'): CloudError =>
  new CloudError(401, 'UNAUTHENTICATED', 'auth', message);
export const forbidden = (message: string): CloudError =>
  new CloudError(403, 'FORBIDDEN', 'permission', message);
export const notFound = (message = '资源不存在'): CloudError =>
  new CloudError(404, 'NOT_FOUND', 'contract', message, 'retry_read');
export const idempotencyMismatch = (): CloudError =>
  new CloudError(409, 'IDEMPOTENCY_MISMATCH', 'sync', '同一幂等键绑定了不同请求，不会复用不相关结果');
export const rateLimited = (message: string, retryAfter: number): CloudError =>
  new CloudError(429, 'RATE_LIMITED', 'rate-limit', message, undefined, { retryAfter });
export const storageUnavailable = (): CloudError =>
  new CloudError(503, 'STORAGE_UNAVAILABLE', 'storage', '存储暂不可用；已有离线内容不受影响', 'retry_read');
