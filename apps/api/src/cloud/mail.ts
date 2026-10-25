import type { CloudPool, Querier } from './db/client.js';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';

const MailMessageSchema = z.object({
  recipient: z.string().email().max(320),
  subject: z.string().max(200),
  text: z.string().max(4096),
});
export type MailMessage = z.infer<typeof MailMessageSchema>;

function mailRecipientDigest(key: Buffer, recipient: string): Buffer {
  return createHmac('sha256', key).update(`mail-recipient\0${recipient}`).digest();
}

export function sealMail(key: Buffer, id: string, message: MailMessage): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(id));
  const body = Buffer.concat([cipher.update(JSON.stringify(MailMessageSchema.parse(message)), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), body]);
}

export function openMail(key: Buffer, id: string, payload: Buffer): MailMessage {
  if (payload.length < 30 || payload[0] !== 1) throw new Error('邮件密文格式无效');
  const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(1, 13));
  decipher.setAAD(Buffer.from(id));
  decipher.setAuthTag(payload.subarray(13, 29));
  const body = Buffer.concat([decipher.update(payload.subarray(29)), decipher.final()]);
  return MailMessageSchema.parse(JSON.parse(body.toString('utf8')));
}

/**
 * 邮件投递通道：验证码经 mail_outbox 持久化后由投递进程发出。
 * 投递行与挑战在同一数据库事务写入，挑战成立才存在待发邮件。
 * 真实邮件通道（SMTP/服务商）是后续环境决策；本接口不假装已发送。
 */
export interface Mailer {
  /** 在调用方的事务内登记待发邮件，返回 mail_outbox.id。 */
  queue(q: Querier, message: MailMessage & { expiresAt: Date }): Promise<string>;
}

export class OutboxMailer implements Mailer {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('邮件队列密钥必须为 32 字节');
  }

  async queue(q: Querier, message: MailMessage & { expiresAt: Date }): Promise<string> {
    const id = randomUUID();
    const result = await q.query<{ id: string }>(
      `INSERT INTO mail_outbox (id, recipient, subject, body, recipient_digest, payload, expires_at)
       VALUES ($1, '', '', '', $2, $3, $4) RETURNING id`,
      [id, mailRecipientDigest(this.key, message.recipient), sealMail(this.key, id, message), message.expiresAt]);
    return result.rows[0]!.id;
  }
}

/** 测试/本地读取待发邮件的受控查询（不经过 HTTP 接口）。 */
export async function readQueuedMail(pool: CloudPool, recipient: string, key: Buffer) {
  const result = await pool.query<{ id: string; payload: Buffer; created_at: Date }>(
    'SELECT id, payload, created_at FROM mail_outbox WHERE recipient_digest = $1 AND payload IS NOT NULL ORDER BY created_at DESC, id',
    [mailRecipientDigest(key, recipient)]);
  return result.rows.map((row) => {
    const message = openMail(key, row.id, row.payload);
    return { id: row.id, subject: message.subject, body: message.text, created_at: row.created_at };
  });
}
