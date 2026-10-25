import type { CloudPool, Querier } from './db/client.js';

/**
 * 邮件投递通道：验证码经 mail_outbox 持久化后由投递进程发出。
 * 投递行与挑战在同一数据库事务写入，挑战成立才存在待发邮件。
 * 真实邮件通道（SMTP/服务商）是后续环境决策；本接口不假装已发送。
 */
export interface Mailer {
  /** 在调用方的事务内登记待发邮件，返回 mail_outbox.id。 */
  queue(q: Querier, message: { recipient: string; subject: string; text: string }): Promise<string>;
}

export class OutboxMailer implements Mailer {
  async queue(q: Querier, message: { recipient: string; subject: string; text: string }): Promise<string> {
    const result = await q.query<{ id: string }>(
      'INSERT INTO mail_outbox (recipient, subject, body) VALUES ($1, $2, $3) RETURNING id',
      [message.recipient, message.subject, message.text]);
    return result.rows[0]!.id;
  }
}

/** 测试/本地读取待发邮件的受控查询（不经过 HTTP 接口）。 */
export async function readQueuedMail(pool: CloudPool, recipient: string) {
  const result = await pool.query<{ id: string; subject: string; body: string; created_at: Date }>(
    'SELECT id, subject, body, created_at FROM mail_outbox WHERE recipient = $1 ORDER BY created_at DESC',
    [recipient]);
  return result.rows;
}
