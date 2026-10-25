import type { Querier } from './client.js';

/**
 * 账号级串行入口（计划 §5.5）。多资源商业变更都先取得这一行，
 * 然后按固定顺序取工作区/流/账本行锁；反向先取工作区锁再申请账号锁会造成死锁。
 */
export async function lockAccount(q: Querier, account: string): Promise<void> {
  await q.query('INSERT INTO account_control (account_id) VALUES ($1) ON CONFLICT DO NOTHING', [account]);
  await q.query('SELECT account_id FROM account_control WHERE account_id = $1 FOR UPDATE', [account]);
}
