import { createHmac } from 'node:crypto';
import type { CloudPool } from '../db/client.js';
import { rateLimited } from '../errors.js';

export async function consumeAuthLimit(
  pool: CloudPool, pepper: Buffer, scope: string, key: string, limit: number, windowSeconds: number,
): Promise<void> {
  const digest = createHmac('sha256', pepper).update(`auth-limit\0${scope}\0${key}`).digest();
  const result = await pool.query<{ hits: number; retry_after: number }>(
    `INSERT INTO auth_rate_limits (scope, key_digest, hits) VALUES ($1, $2, 1)
     ON CONFLICT (scope, key_digest) DO UPDATE SET
       hits = CASE WHEN auth_rate_limits.window_started_at <= now() - make_interval(secs => $3)
         THEN 1 ELSE least(auth_rate_limits.hits + 1, $4 + 1) END,
       window_started_at = CASE WHEN auth_rate_limits.window_started_at <= now() - make_interval(secs => $3)
         THEN now() ELSE auth_rate_limits.window_started_at END
     RETURNING hits, greatest(1, ceil(extract(epoch FROM window_started_at + make_interval(secs => $3) - now())))::int AS retry_after`,
    [scope, digest, windowSeconds, limit],
  );
  if (result.rows[0]!.hits > limit) {
    throw rateLimited('登录请求过于频繁，请稍后重试', result.rows[0]!.retry_after);
  }
}
