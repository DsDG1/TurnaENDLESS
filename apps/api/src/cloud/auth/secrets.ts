import { createHmac, createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * 身份秘密原语（§4.2）：
 * - 验证码：加密随机 6 位；服务端只存 HMAC 摘要，不存明文。
 * - 会话令牌：32 字节高熵不透明串；服务端只存 SHA-256 摘要。
 */

export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/** 挑战摘要绑定用途+挑战+接收方+验证码，防止跨挑战/跨用途重放。 */
export function otpDigest(pepper: Buffer, challengeId: string, email: string, code: string): Buffer {
  return createHmac('sha256', pepper).update('otp\0').update(challengeId).update('\0').update(email).update('\0').update(code).digest();
}

export function verifyOtp(pepper: Buffer, challengeId: string, email: string, code: string, expected: Buffer): boolean {
  const actual = otpDigest(pepper, challengeId, email, code);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 接收方速率限流索引：不可逆 HMAC，不落邮箱明文到查询路径。 */
export function recipientDigest(pepper: Buffer, email: string): Buffer {
  return createHmac('sha256', pepper).update('recipient\0').update(email).digest();
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sessionDigest(token: string): Buffer {
  return createHash('sha256').update(`session\0${token}`).digest();
}

export function requestDigestHex(normalizedBody: string): Buffer {
  return createHash('sha256').update(normalizedBody).digest();
}
