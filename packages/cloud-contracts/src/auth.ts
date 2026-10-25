import { z } from 'zod';
import { UuidSchema } from './envelope.js';

/** 身份与会话契约（§4）。邮箱一次性验证码是首个登录渠道。 */

export const EmailSchema = z.string().trim().toLowerCase().email().max(320);

export const ChallengeRequestSchema = z.object({
  email: EmailSchema,
});
export type ChallengeRequest = z.infer<typeof ChallengeRequestSchema>;

/** 响应形状对“账号是否存在”不敏感；不存在时不暗示已注册。 */
export const ChallengeResponseSchema = z.object({
  challengeId: UuidSchema,
  expiresAt: z.string().datetime(),
  resendAfterSeconds: z.number().int().nonnegative(),
});
export type ChallengeResponse = z.infer<typeof ChallengeResponseSchema>;

export const VerifyRequestSchema = z.object({
  challengeId: UuidSchema,
  /** 验证码摘要绑定邮箱；邮箱不一致即验证失败，挑战对其它接收方不可见。 */
  email: EmailSchema,
  code: z.string().trim().min(4).max(16),
  deviceName: z.string().trim().min(1).max(80).optional(),
});
export type VerifyRequest = z.infer<typeof VerifyRequestSchema>;

/** 会话令牌只通过 HttpOnly Cookie 传递，响应体不携带。 */
export const VerifyResponseSchema = z.object({
  accountId: UuidSchema,
  deviceId: UuidSchema,
  sessionExpiresAt: z.string().datetime(),
});
export type VerifyResponse = z.infer<typeof VerifyResponseSchema>;

export const DeviceSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
  current: z.boolean(),
});
export type Device = z.infer<typeof DeviceSchema>;

export const MeResponseSchema = z.object({
  account: z.object({
    id: UuidSchema,
    status: z.enum(['active', 'deletion_pending', 'deleted']),
    createdAt: z.string().datetime(),
  }),
  device: DeviceSchema,
  entitlements: z.array(z.object({
    kind: z.string(),
    scope: z.string(),
    validUntil: z.string().datetime().nullable(),
  })),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const DeviceListResponseSchema = z.object({ devices: z.array(DeviceSchema) });
export type DeviceListResponse = z.infer<typeof DeviceListResponseSchema>;
