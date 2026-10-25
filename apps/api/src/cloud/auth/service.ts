import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { CloudPool, Querier } from '../db/client.js';
import { CloudError, rateLimited, unauthorized } from '../errors.js';
import type { Mailer } from '../mail.js';
import { generateOtpCode, generateSessionToken, otpDigest, recipientDigest, sessionDigest, verifyOtp } from './secrets.js';
import { SlidingWindow } from './rate-limit.js';
import { consumeAuthLimit } from './limits.js';

/**
 * 身份与会话服务（§4）。
 * 首个渠道：邮箱一次性验证码——绑定用途+接收方+挑战 ID、短有效期、
 * 一次消费、服务端只存摘要、按接收方与来源限流。
 */

const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const CHALLENGE_MAX_ATTEMPTS = 8;
const CHALLENGE_PER_RECIPIENT_HOUR = 5;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEVICE_NAME_MAX = 80;
const DEVICES_PER_ACCOUNT = 50;
const RESEND_AFTER_SECONDS = 60;

export interface AuthContext {
  accountId: string;
  sessionId: string;
  deviceId: string;
}

interface ChallengeRow {
  id: string;
  purpose: string;
  recipient_digest: Buffer;
  code_digest: Buffer;
  expires_at: Date;
  consumed_at: Date | null;
  attempts: number;
  max_attempts: number;
}

export class AuthService {
  /** 匿名端点按 IP 的进程内限流；收件人维度另有数据库计数（跨实例一致）。 */
  private readonly ipWindow = new SlidingWindow(10, 60 * 60 * 1000);

  constructor(
    private readonly auth: CloudPool,
    private readonly mailer: Mailer,
    private readonly pepper: Buffer,
    private readonly mailEcho = false,
    private readonly now: () => Date = () => new Date(),
  ) {}

  clientIp(request: { headers: Record<string, unknown>; socket?: { remoteAddress?: string } }): string {
    // 不接受客户端转发的 X-Forwarded-For：本服务位于网关后，网关如可信应在
    // 入口层覆盖 remoteAddress；直接采信头部会把限流键交给请求方伪造。
    return request.socket?.remoteAddress ?? 'unknown';
  }

  /** 签发一次性验证码。响应不暴露账号是否存在；限流失败是显式 429。 */
  async issueChallenge(input: { email: string; ip: string }, correlation: string): Promise<{ challengeId: string; expiresAt: string; resendAfterSeconds: number }> {
    const email = input.email;
    this.ipWindow.sweep();
    const ipTake = this.ipWindow.take(`challenge:${input.ip}`);
    if (!ipTake.ok) throw rateLimited('验证码请求过于频繁，请稍后重试', ipTake.retryAfter);
    await consumeAuthLimit(this.auth, this.pepper, 'challenge_ip', input.ip, 10, 3600);
    const recipient = recipientDigest(this.pepper, email);
    return this.auth.withSystem(async (q) => {
      await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`challenge:${recipient.toString('hex')}`]);
      const recent = await q.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM auth_challenges WHERE recipient_digest = $1 AND created_at > now() - interval \'1 hour\'',
        [recipient]);
      if (Number(recent.rows[0]?.count ?? 0) >= CHALLENGE_PER_RECIPIENT_HOUR) {
        throw rateLimited('该邮箱验证码请求过于频繁，请稍后重试', 3600);
      }
      const code = generateOtpCode();
      const challengeId = randomUUID();
      const expiresAt = new Date(this.now().getTime() + CHALLENGE_TTL_MS);
      const delivery = await this.mailer.queue(q, {
        recipient: email,
        subject: 'ENDLESS 登录验证码',
        text: `你的 ENDLESS 登录验证码是 ${code}，10 分钟内有效。若非本人操作请忽略本邮件。`,
        expiresAt,
      });
      // 摘要一次性绑定 用途+挑战+接收方+验证码；不存在先占位再写回的中间态。
      await q.query(
        `INSERT INTO auth_challenges (id, purpose, recipient_digest, code_digest, delivery_ref, expires_at, max_attempts)
         VALUES ($1, 'sign_in', $2, $3, $4, $5, $6)`,
        [challengeId, recipient, otpDigest(this.pepper, challengeId, email, code), delivery, expiresAt, CHALLENGE_MAX_ATTEMPTS]);
      await this.audit(q, null, 'auth.challenge_issued', 'auth_challenge', challengeId, undefined, correlation);
      if (this.mailEcho) console.log(`[cloud:dev-mail] 验证码邮件（${email}）：${code}`);
      return { challengeId, expiresAt: expiresAt.toISOString(), resendAfterSeconds: RESEND_AFTER_SECONDS };
    });
  }

  /** 校验验证码：一次消费；验证通过即建立身份/账号、设备与会话。 */
  async verifyChallenge(input: { challengeId: string; code: string; deviceName?: string; email: string }, correlation: string, previousToken?: string | null, ip?: string): Promise<{ token: string; accountId: string; deviceId: string; sessionExpiresAt: string }> {
    if (ip) await consumeAuthLimit(this.auth, this.pepper, 'verify_ip', ip, 60, 60);
    const result = await this.auth.withSystem(async (q) => {
      const found = await q.query<ChallengeRow>('SELECT * FROM auth_challenges WHERE id = $1 FOR UPDATE', [input.challengeId]);
      const challenge = found.rows[0];
      if (!challenge || challenge.consumed_at !== null || challenge.expires_at <= this.now() || challenge.attempts >= challenge.max_attempts) {
        throw unauthorized('验证码无效或已过期，请重新获取');
      }
      await q.query('UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = $1', [challenge.id]);
      const email = input.email;
      // 接收方绑定：挑战不属于该邮箱时与错误验证码同等失败，不区分提示。
      const bound = timingSafeEqual(recipientDigest(this.pepper, email), challenge.recipient_digest);
      if (!bound || !verifyOtp(this.pepper, challenge.id, email, input.code.trim(), challenge.code_digest)) {
        await this.audit(q, null, 'auth.challenge_rejected', 'auth_challenge', challenge.id, undefined, correlation);
        return { error: unauthorized('验证码无效或已过期，请重新获取') };
      }
      await q.query('UPDATE auth_challenges SET consumed_at = now() WHERE id = $1', [challenge.id]);
      const accountId = await this.accountForIdentity(q, 'email', email);
      const deviceId = await this.createDevice(q, accountId, input.deviceName ?? '未命名设备');
      const token = generateSessionToken();
      const sessionExpiresAt = new Date(this.now().getTime() + SESSION_TTL_MS);
      const digest = sessionDigest(token);
      const previous = previousToken ? await q.query<{ id: string; account_id: string }>(
        'UPDATE sessions SET revoked_at = now() WHERE token_digest = $1 AND revoked_at IS NULL RETURNING id, account_id',
        [sessionDigest(previousToken)],
      ) : null;
      if (previous?.rows[0]) {
        await this.audit(q, previous.rows[0].account_id, 'auth.session_rotated', 'session', previous.rows[0].id, undefined, correlation);
      }
      await q.query(
        `INSERT INTO sessions (account_id, device_id, token_digest, auth_strength, expires_at, rotated_from)
         VALUES ($1, $2, $3, 'email_otp', $4, $5)`,
        [accountId, deviceId, digest, sessionExpiresAt, previous?.rows[0]?.id ?? null]);
      await this.audit(q, accountId, 'auth.session_created', 'device', deviceId, undefined, correlation);
      return { token, accountId, deviceId, sessionExpiresAt: sessionExpiresAt.toISOString() };
    });
    if ('error' in result) throw result.error;
    return result;
  }

  /** 邮箱身份 → 账号；同邮箱并发验证用 advisory lock 串行化，避免双账号。 */
  private async accountForIdentity(q: Querier, issuer: string, subject: string): Promise<string> {
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${issuer}:${subject}`]);
    const existing = await q.query<{ account_id: string }>(
      'SELECT account_id FROM auth_identities WHERE issuer = $1 AND subject = $2', [issuer, subject]);
    if (existing.rows[0]) {
      const account = await q.query<{ id: string; status: string }>('SELECT id, status FROM accounts WHERE id = $1', [existing.rows[0].account_id]);
      if (account.rows[0]?.status !== 'active') throw unauthorized('该账号不可登录');
      return existing.rows[0].account_id;
    }
    const account = await q.query<{ id: string }>('INSERT INTO accounts DEFAULT VALUES RETURNING id');
    const accountId = account.rows[0]!.id;
    await q.query(
      'INSERT INTO auth_identities (account_id, issuer, subject, verified_at) VALUES ($1, $2, $3, now())',
      [accountId, issuer, subject]);
    await this.audit(q, accountId, 'account.created', 'account', accountId);
    return accountId;
  }

  private async createDevice(q: Querier, accountId: string, name: string): Promise<string> {
    const active = await q.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM devices WHERE account_id = $1 AND revoked_at IS NULL', [accountId]);
    if (Number(active.rows[0]?.count ?? 0) >= DEVICES_PER_ACCOUNT) {
      throw new CloudError(409, 'PLATFORM_CAPACITY', 'capacity', '设备数量已达上限，请先撤销不使用的设备');
    }
    const device = await q.query<{ id: string }>(
      'INSERT INTO devices (account_id, name) VALUES ($1, $2) RETURNING id',
      [accountId, name.slice(0, DEVICE_NAME_MAX)]);
    return device.rows[0]!.id;
  }

  /** 会话解析：仅按令牌摘要查找；撤销/过期/设备吊销都不通过。 */
  async resolveSession(token: string): Promise<AuthContext | null> {
    const digest = sessionDigest(token);
    const result = await this.auth.query<{ id: string; account_id: string; device_id: string | null; device_revoked: Date | null }>(
      `SELECT s.id, s.account_id, s.device_id, d.revoked_at AS device_revoked
       FROM sessions s JOIN devices d ON d.id = s.device_id AND d.account_id = s.account_id
       JOIN accounts a ON a.id = s.account_id AND a.status = 'active'
       WHERE s.token_digest = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [digest]);
    const row = result.rows[0];
    if (!row || !row.device_id || row.device_revoked !== null) return null;
    // 设备活跃时间低频刷新，避免读路径放大写。
    await this.auth.query(
      'UPDATE devices SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval \'15 minutes\'',
      [row.device_id]).catch(() => {});
    return { accountId: row.account_id, sessionId: row.id, deviceId: row.device_id };
  }

  async logout(ctx: AuthContext, correlation: string): Promise<void> {
    await this.auth.withSystem(async (q) => {
      await q.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [ctx.sessionId]);
      await this.audit(q, ctx.accountId, 'auth.session_revoked', 'session', ctx.sessionId, undefined, correlation);
    });
  }

  async listDevices(accountId: string) {
    const result = await this.auth.query<{
      id: string; name: string; created_at: Date; last_seen_at: Date; revoked_at: Date | null;
    }>(
      'SELECT id, name, created_at, last_seen_at, revoked_at FROM devices WHERE account_id = $1 ORDER BY created_at',
      [accountId]);
    return result.rows;
  }

  /** 撤销设备：连带吊销该设备上的全部会话（同一身份域事务）。 */
  async revokeDevice(ctx: AuthContext, deviceId: string, correlation: string): Promise<{ revokedSelf: boolean }> {
    return this.auth.withSystem(async (q) => {
      const device = await q.query<{ id: string }>(
        'SELECT id FROM devices WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL FOR UPDATE',
        [deviceId, ctx.accountId]);
      if (!device.rows[0]) throw new CloudError(404, 'NOT_FOUND', 'contract', '设备不存在或已撤销', 'retry_read');
      await q.query('UPDATE devices SET revoked_at = now() WHERE id = $1', [deviceId]);
      await q.query('UPDATE sessions SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL', [deviceId]);
      await this.audit(q, ctx.accountId, 'auth.device_revoked', 'device', deviceId, undefined, correlation);
      return { revokedSelf: deviceId === ctx.deviceId };
    });
  }

  /** 审计：身份域写入；actor 为 NULL 表示系统动作。带 actor 的写入先在本事务内
   *  设置租户上下文，否则 audit_events 的 RLS WITH CHECK 会合法拒绝。 */
  private async audit(q: Querier, actorAccountId: string | null, action: string, objectType: string, objectId: string, reason?: string, correlation?: string): Promise<void> {
    if (actorAccountId) {
      await q.query('SELECT set_config($1, $2, true)', ['endless.tenant_id', actorAccountId]);
    }
    await q.query(
      'INSERT INTO audit_events (actor_account_id, action, object_type, object_id, reason, correlation_id) VALUES ($1, $2, $3, $4, $5, $6)',
      [actorAccountId, action, objectType, objectId, reason ?? null, correlation ?? null]);
  }
}
