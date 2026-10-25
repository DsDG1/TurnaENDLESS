import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutboxMailer } from '../../src/cloud/mail.js';
import { MailWorker } from '../../src/cloud/mail-worker.js';
import type { MailTransport } from '../../src/cloud/smtp.js';
import { cloudFixture, fakeSmtp, mailText, runCloudProcess, TEST_MAIL_KEY } from './fixtures.js';

let fixture: Awaited<ReturnType<typeof cloudFixture>>;
const cleanups: (() => Promise<unknown>)[] = [];

beforeAll(async () => { fixture = await cloudFixture(); }, 120_000);
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
afterAll(async () => { await fixture?.close(); }, 60_000);

async function queue(text: string, expiresAt = new Date(Date.now() + 600_000)) {
  return fixture.auth.withSystem((q) => new OutboxMailer(TEST_MAIL_KEY).queue(q, {
    recipient: `mail-${randomUUID()}@example.test`, subject: 'Synthetic ENDLESS OTP', text, expiresAt,
  }));
}

function stubTransport(send: MailTransport['send']): MailTransport {
  return { send, close() {} };
}

describe('C1 邮件 Worker 与真实 SMTP 协议', () => {
  it.each([true, false])('使用受信任证书投递，TLS=%s；双 Worker 只发送一次且清理正文', async (secure) => {
    const smtp = await fakeSmtp(secure);
    cleanups.push(smtp.close);
    const id = await queue('synthetic OTP 654321');
    const workers = Array.from({ length: 2 }, () => new MailWorker(fixture.auth, TEST_MAIL_KEY, smtp.transport));
    expect((await Promise.all(workers.map((worker) => worker.runOnce()))).filter(Boolean)).toHaveLength(1);
    expect(smtp.messages).toHaveLength(1);
    expect(mailText(smtp.messages[0]!)).toContain('654321');
    expect(smtp.tlsConnections).toBe(1);
    const row = await fixture.auth.query(
      'SELECT m.status, m.payload, m.body, m.recipient, a.status AS attempt_status FROM mail_outbox m JOIN mail_delivery_attempts a ON a.mail_id = m.id WHERE m.id = $1',
      [id],
    );
    expect(row.rows[0]).toMatchObject({ status: 'sent', payload: null, body: '', recipient: '', attempt_status: 'sent' });
    expect(await workers[0]!.runOnce()).toBe(false);
  });

  it('不信任的 SMTP 证书不能投递，未知状态不自动重发', async () => {
    const smtp = await fakeSmtp(true, false);
    cleanups.push(smtp.close);
    const id = await queue('synthetic-untrusted-mail');
    const worker = new MailWorker(fixture.auth, TEST_MAIL_KEY, smtp.transport);
    expect(await worker.runOnce()).toBe(true);
    expect(smtp.messages).toHaveLength(0);
    expect(await worker.runOnce()).toBe(false);
    const result = await fixture.auth.query('SELECT status, error_code FROM mail_delivery_attempts WHERE mail_id = $1', [id]);
    expect(result.rows[0]).toMatchObject({ status: 'unknown', error_code: 'DELIVERY_UNKNOWN' });
  });

  it('超时和明确拒收只记录安全代码，不保留服务商响应或重复发送', async () => {
    for (const rejected of [false, true]) {
      const id = await queue('synthetic-error-mail');
      let calls = 0;
      const worker = new MailWorker(fixture.auth, TEST_MAIL_KEY, stubTransport(async () => {
        calls++;
        throw Object.assign(new Error('synthetic-secret-provider-body'), { responseCode: rejected ? 550 : undefined });
      }));
      expect(await worker.runOnce()).toBe(true);
      expect(await worker.runOnce()).toBe(false);
      expect(calls).toBe(1);
      const result = await fixture.auth.query('SELECT status, error_code FROM mail_delivery_attempts WHERE mail_id = $1', [id]);
      expect(result.rows[0]).toEqual({
        status: rejected ? 'failed' : 'unknown', error_code: rejected ? 'SMTP_REJECTED' : 'DELIVERY_UNKNOWN',
      });
    }
  });

  it('崩溃遗留 sending 标记 unknown，过期邮件不发送', async () => {
    const id = await queue('synthetic-interrupted-mail');
    await fixture.auth.query(
      "INSERT INTO mail_delivery_attempts (mail_id, claim_token, status, started_at) VALUES ($1, $2, 'sending', now() - interval '2 minutes')",
      [id, randomUUID()],
    );
    const expired = await queue('synthetic-expired-mail', new Date(Date.now() - 1000));
    let calls = 0;
    const worker = new MailWorker(fixture.auth, TEST_MAIL_KEY, stubTransport(async () => { calls++; }));
    expect(await worker.runOnce()).toBe(false);
    expect(calls).toBe(0);
    expect((await fixture.auth.query('SELECT status FROM mail_delivery_attempts WHERE mail_id = $1', [id])).rows[0]?.status).toBe('unknown');
    const rows = await fixture.auth.query('SELECT status, payload FROM mail_outbox WHERE id = ANY($1::uuid[])', [[id, expired]]);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((row) => row.status === 'failed' && row.payload === null)).toBe(true);
  });

  it('验证码邮件和业务事务一起回滚，队列表不保存验证码或邮箱明文', async () => {
    let rolledBack = '';
    await expect(fixture.auth.withSystem(async (q) => {
      rolledBack = await new OutboxMailer(TEST_MAIL_KEY).queue(q, {
        recipient: 'synthetic-private@example.test', subject: 'synthetic', text: 'synthetic-OTP-135790',
        expiresAt: new Date(Date.now() + 600_000),
      });
      throw new Error('synthetic-transaction-rollback');
    })).rejects.toThrow('synthetic-transaction-rollback');
    expect((await fixture.auth.query('SELECT id FROM mail_outbox WHERE id = $1', [rolledBack])).rows).toHaveLength(0);
    const id = await queue('synthetic-OTP-135790');
    const saved = await fixture.auth.query('SELECT recipient, subject, body, payload FROM mail_outbox WHERE id = $1', [id]);
    expect(saved.rows[0]).toMatchObject({ recipient: '', subject: '', body: '' });
    expect(saved.rows[0]!.payload.includes(Buffer.from('135790'))).toBe(false);
    await new MailWorker(fixture.auth, TEST_MAIL_KEY, stubTransport(async () => {})).runOnce();
  });

  it('非 Error 的投递失败也进入 unknown，不能绕过恢复状态机', async () => {
    const id = await queue('synthetic-null-error');
    const worker = new MailWorker(fixture.auth, TEST_MAIL_KEY, stubTransport(async () => { throw null; }));
    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(false);
    expect((await fixture.auth.query('SELECT status FROM mail_delivery_attempts WHERE mail_id = $1', [id])).rows[0]?.status).toBe('unknown');
  });

  it('SMTP 已接受但结果写库失败，恢复不重发', async () => {
    const id = await queue('synthetic-accepted-mail');
    let calls = 0;
    const worker = new MailWorker(fixture.auth, TEST_MAIL_KEY, stubTransport(async () => {
      calls++;
      vi.spyOn(fixture.auth, 'withSystem').mockRejectedValueOnce(new Error('synthetic-database-outage'));
    }));
    await expect(worker.runOnce()).rejects.toThrow('synthetic-database-outage');
    vi.restoreAllMocks();
    await fixture.auth.query(
      "UPDATE mail_delivery_attempts SET started_at = now() - interval '2 minutes' WHERE mail_id = $1", [id],
    );
    await worker.runOnce();
    expect(calls).toBe(1);
    expect((await fixture.auth.query('SELECT status FROM mail_delivery_attempts WHERE mail_id = $1', [id])).rows[0]?.status).toBe('unknown');
  });

  it('过期 claim 的迟到成功不能改写 unknown 或重新发送', async () => {
    const id = await queue('synthetic-late-mail');
    let calls = 0;
    const worker = new MailWorker(fixture.auth, TEST_MAIL_KEY, stubTransport(async () => {
      calls++;
      await fixture.auth.query(
        "UPDATE mail_delivery_attempts SET started_at = now() - interval '2 minutes' WHERE mail_id = $1", [id],
      );
      await new MailWorker(fixture.auth, TEST_MAIL_KEY, stubTransport(async () => { calls++; })).recover();
    }));
    await worker.runOnce();
    expect(await worker.runOnce()).toBe(false);
    expect(calls).toBe(1);
    expect((await fixture.auth.query('SELECT status FROM mail_delivery_attempts WHERE mail_id = $1', [id])).rows[0]?.status).toBe('unknown');
  });

  it('独立 Worker 进程读取显式配置，仅通过本地 SMTP 投递', async () => {
    const smtp = await fakeSmtp(true);
    cleanups.push(smtp.close);
    const root = await mkdtemp(join(tmpdir(), 'endless-cloud-worker-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const caFile = join(root, 'smtp-ca.pem');
    await writeFile(caFile, smtp.certificate.cert);
    await queue('synthetic-worker-process OTP 246810');
    const result = await runCloudProcess('worker', {
      ENDLESS_CLOUD_ENV: 'test', ENDLESS_CLOUD_AUTH_DSN: fixture.authDsn,
      ENDLESS_CLOUD_MAIL_KEY: TEST_MAIL_KEY.toString('hex'),
      ENDLESS_CLOUD_SMTP_ENV: 'test', ENDLESS_CLOUD_SMTP_HOST: 'localhost',
      ENDLESS_CLOUD_SMTP_PORT: String(smtp.port), ENDLESS_CLOUD_SMTP_FROM: 'endless@example.test',
      ENDLESS_CLOUD_SMTP_USER: 'synthetic', ENDLESS_CLOUD_SMTP_PASSWORD: 'synthetic-smtp',
      ENDLESS_CLOUD_SMTP_CA_FILE: caFile,
    }, ['--once']);
    expect(result.code, result.output).toBe(0);
    expect(smtp.messages).toHaveLength(1);
    expect(mailText(smtp.messages[0]!)).toContain('246810');
    for (const secret of ['246810', 'synthetic-smtp', TEST_MAIL_KEY.toString('hex')]) expect(result.output).not.toContain(secret);
  }, 45_000);
});
