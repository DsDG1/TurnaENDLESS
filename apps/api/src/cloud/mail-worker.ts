import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import type { CloudPool } from './db/client.js';
import { openMail } from './mail.js';
import type { MailTransport } from './smtp.js';

interface QueuedMail {
  id: string;
  payload: Buffer | null;
  expires_at: Date;
}

export class MailWorker {
  constructor(
    private readonly auth: CloudPool,
    private readonly key: Buffer,
    private readonly transport: MailTransport,
  ) {}

  async recover(): Promise<void> {
    await this.auth.withSystem(async (q) => {
      const unknown = await q.query<{ mail_id: string }>(
        `UPDATE mail_delivery_attempts SET status = 'unknown', finished_at = now(), error_code = 'DELIVERY_UNKNOWN'
         WHERE status = 'sending' AND started_at < now() - interval '1 minute' RETURNING mail_id`,
      );
      await q.query(
        `UPDATE mail_outbox SET status = 'failed', payload = NULL, recipient = '', subject = '', body = ''
         WHERE (status = 'queued' AND expires_at <= now()) OR id = ANY($1::uuid[])`,
        [unknown.rows.map((row) => row.mail_id)],
      );
    });
  }

  async runOnce(): Promise<boolean> {
    await this.recover();
    const token = randomUUID();
    const mail = await this.auth.withSystem(async (q) => {
      const result = await q.query<QueuedMail>(
        `SELECT m.id, m.payload, m.expires_at FROM mail_outbox m
         WHERE m.status = 'queued' AND m.expires_at > now()
           AND NOT EXISTS (SELECT 1 FROM mail_delivery_attempts a WHERE a.mail_id = m.id)
         ORDER BY m.created_at, m.id LIMIT 1 FOR UPDATE OF m SKIP LOCKED`,
      );
      const row = result.rows[0];
      if (!row) return null;
      await q.query(
        "INSERT INTO mail_delivery_attempts (mail_id, claim_token, status) VALUES ($1, $2, 'sending')",
        [row.id, token],
      );
      return row;
    });
    if (!mail) return false;
    let status: 'sent' | 'failed' | 'unknown' = 'sent';
    let code: string | null = null;
    try {
      if (!mail.payload) throw new Error('MAIL_PAYLOAD_UNAVAILABLE');
      const message = openMail(this.key, mail.id, mail.payload);
      if (mail.expires_at.getTime() <= Date.now()) throw new Error('MAIL_EXPIRED');
      await this.transport.send(mail.id, message);
    } catch (error) {
      const responseCode = (error as { responseCode?: unknown } | null)?.responseCode;
      const rejected = typeof responseCode === 'number' && responseCode >= 400 && responseCode < 600;
      const unavailable = error instanceof Error && (error.message === 'MAIL_PAYLOAD_UNAVAILABLE' || error.message === 'MAIL_EXPIRED');
      status = rejected || unavailable ? 'failed' : 'unknown';
      code = rejected ? 'SMTP_REJECTED' : unavailable ? 'MAIL_UNAVAILABLE' : 'DELIVERY_UNKNOWN';
    }
    await this.auth.withSystem(async (q) => {
      const result = await q.query(
        `UPDATE mail_delivery_attempts SET status = $1, finished_at = now(), error_code = $2
         WHERE mail_id = $3 AND claim_token = $4 AND status = 'sending' RETURNING mail_id`,
        [status, code, mail.id, token],
      );
      if (result.rowCount === 0) return;
      await q.query(
        `UPDATE mail_outbox SET status = $1, sent_at = CASE WHEN $1 = 'sent' THEN now() ELSE NULL END,
         payload = NULL, recipient = '', subject = '', body = '' WHERE id = $2`,
        [status === 'sent' ? 'sent' : 'failed', mail.id],
      );
    });
    return true;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (await this.runOnce()) continue;
      await setTimeout(1000, undefined, { signal }).catch((error: unknown) => {
        if (!signal.aborted) throw error;
      });
    }
  }
}
