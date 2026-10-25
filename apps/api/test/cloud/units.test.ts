import { describe, expect, it } from 'vitest';
import { CloudCapabilitiesSchema, CloudErrorBodySchema, IdempotencyKeySchema } from '@endless/cloud-contracts';
import { generateOtpCode, generateSessionToken, otpDigest, recipientDigest, sessionDigest, verifyOtp } from '../../src/cloud/auth/secrets.js';
import { SlidingWindow } from '../../src/cloud/auth/rate-limit.js';
import { cloudCapabilities } from '../../src/cloud/capabilities.js';
import { parseCookies, sessionCookie, clearSessionCookie } from '../../src/cloud/http.js';
import { roleBootstrapSql } from '../../src/cloud/db/roles.js';
import { CloudError } from '../../src/cloud/errors.js';

const pepper = Buffer.from('unit-test-pepper-that-is-32bytes!!');

describe('云秘密原语', () => {
  it('验证码为 6 位数字且摘要可校验', () => {
    const code = generateOtpCode();
    expect(code).toMatch(/^\d{6}$/);
    const digest = otpDigest(pepper, 'c1', 'a@b.c', code);
    expect(verifyOtp(pepper, 'c1', 'a@b.c', code, digest)).toBe(true);
    expect(verifyOtp(pepper, 'c1', 'a@b.c', '000000', digest)).toBe(false);
    // 摘要绑定挑战与接收方：换挑战/换邮箱均失败
    expect(verifyOtp(pepper, 'c2', 'a@b.c', code, digest)).toBe(false);
    expect(verifyOtp(pepper, 'c1', 'x@y.z', code, digest)).toBe(false);
    expect(verifyOtp(Buffer.from('other-pepper-other-pepper-32bytes!'), 'c1', 'a@b.c', code, digest)).toBe(false);
  });

  it('会话令牌高熵且摘要不可逆推出', () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(sessionDigest(a).equals(sessionDigest(b))).toBe(false);
  });

  it('接收方摘要不可逆且稳定', () => {
    const d1 = recipientDigest(pepper, 'a@b.c');
    const d2 = recipientDigest(pepper, 'a@b.c');
    const d3 = recipientDigest(pepper, 'x@y.z');
    expect(d1.equals(d2)).toBe(true);
    expect(d1.equals(d3)).toBe(false);
    expect(d1.length).toBe(32);
  });
});

describe('会话 Cookie', () => {
  it('设置 __Host- 前缀、HttpOnly、Secure、SameSite=Lax', () => {
    const cookie = sessionCookie('tok123', new Date(Date.now() + 60_000));
    expect(cookie).toContain('__Host-endless_session=tok123');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Domain=');
    const cleared = clearSessionCookie();
    expect(cleared).toContain('Max-Age=0');
  });

  it('Cookie 解析', () => {
    const request = { headers: { cookie: '__Host-endless_session=abc; other=1' } } as Parameters<typeof parseCookies>[0];
    expect(parseCookies(request).get('__Host-endless_session')).toBe('abc');
  });
});

describe('限流窗口', () => {
  it('窗口内放行、超限拒绝并给出 retryAfter', () => {
    const window = new SlidingWindow(3, 60_000);
    expect(window.take('k').ok).toBe(true);
    expect(window.take('k').ok).toBe(true);
    expect(window.take('k').ok).toBe(true);
    const denied = window.take('k');
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.retryAfter).toBeGreaterThan(0);
    expect(window.take('other').ok).toBe(true);
  });
});

describe('错误信封与能力', () => {
  it('错误信封符合契约', () => {
    const body = new CloudError(409, 'IDEMPOTENCY_MISMATCH', 'sync', '测试', 'resume_same_request').toBody('corr12345678');
    expect(CloudErrorBodySchema.safeParse(body).success).toBe(true);
  });

  it('capabilities 如实报告：身份域已实现，其余为 false', () => {
    const caps = cloudCapabilities();
    expect(CloudCapabilitiesSchema.safeParse(caps).success).toBe(true);
    expect(caps.features.accounts).toBe(true);
    expect(caps.features.sync).toBe(false);
    expect(caps.features.generation).toBe(false);
    expect(caps.features.payments).toBe(false);
    expect(JSON.stringify(caps)).not.toContain('token');
  });

  it('幂等键校验', () => {
    expect(IdempotencyKeySchema.safeParse('req-12345-abcde').success).toBe(true);
    expect(IdempotencyKeySchema.safeParse('short').success).toBe(false);
    expect(IdempotencyKeySchema.safeParse('has space in it').success).toBe(false);
  });
});

describe('角色引导 SQL', () => {
  it('包含两个角色且口令按字面值转义', () => {
    const sql = roleBootstrapSql({ authPassword: "pa'ss", appPassword: 'app' });
    expect(sql).toContain('endless_auth');
    expect(sql).toContain('endless_app');
    expect(sql).toContain("pa''ss");
    expect(sql).not.toContain('BYPASSRLS');
  });
});
