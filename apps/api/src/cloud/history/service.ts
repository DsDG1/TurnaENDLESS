/**
 * 服务端可信检查点：投影只在原始事件重放成功后写入。
 * 客户端送来的检查点对不上就拒绝，不覆盖已有的另一份摘要。
 */
import { createHash } from 'node:crypto';
import { stableStringify } from '@endless/esl';
import {
  classifyProjector, exportReplay, libraryLoader, replayEvents, replayPrefixHash, type PlayerEvent, type Library,
} from '@endless/player';
import type { CloudPool, Querier } from '../db/client.js';
import { badRequest, CloudError, notFound } from '../errors.js';

const PAGE = 1000;
/** 这一轮验证器可读的上限。超过则拒绝，不截断事件。流表本身的上限仍是 1_000_000。 */
export const REPLAY_VERIFY_EVENT_LIMIT = 100_000;
export const REPLAY_SNAPSHOT_INLINE_BYTES = 2_097_152;

function asPlayerEvent(body: unknown): PlayerEvent {
  if (!body || typeof body !== 'object') throw badRequest('事件正文无法重放');
  const event = body as PlayerEvent;
  if ((event.type !== 'answer' && event.type !== 'advance' && event.type !== 'reveal')
    || typeof event.episode !== 'string' || typeof event.scene !== 'string' || typeof event.at !== 'string') {
    throw badRequest('事件正文无法重放');
  }
  return event;
}

const rejected = (message: string) => new CloudError(422, 'CONTENT_REJECTED', 'contract', message);
const unsupported = (message: string) => new CloudError(409, 'UNSUPPORTED_CONTRACT', 'contract', message);

export class HistoryService {
  constructor(private readonly app: CloudPool) {}

  async verifyStream(accountId: string, input: {
    workspaceId: string;
    streamId: string;
    library: Library;
    claimed?: unknown;
  }): Promise<{ eventCount: number; eventHash: string; digest: string; inline: boolean }> {
    return this.app.withTenant(accountId, (q) => this.verify(q, accountId, input));
  }

  private async verify(q: Querier, accountId: string, input: {
    workspaceId: string;
    streamId: string;
    library: Library;
    claimed?: unknown;
  }) {
    const stream = await q.query<{ event_seq: string }>(
      `SELECT event_seq FROM sync_streams
       WHERE account_id = $1 AND workspace_id = $2 AND stream_id = $3 FOR UPDATE`,
      [accountId, input.workspaceId, input.streamId],
    );
    const row = stream.rows[0];
    if (!row) throw notFound('事件流不存在');
    const eventCount = Number(row.event_seq);
    if (eventCount > REPLAY_VERIFY_EVENT_LIMIT) {
      throw unsupported('该历史超过这一轮可验证的事件上限；原事件保留，不会截断后当作已验证');
    }
    const bodies: unknown[] = [];
    let after = 0;
    while (bodies.length < eventCount) {
      const page = await q.query<{ event_seq: string; body: unknown }>(
        `SELECT se.event_seq, e.body
         FROM stream_events se
         JOIN event_objects e USING (account_id, workspace_id, event_id)
         WHERE se.account_id = $1 AND se.workspace_id = $2 AND se.stream_id = $3 AND se.event_seq > $4
         ORDER BY se.event_seq
         LIMIT $5`,
        [accountId, input.workspaceId, input.streamId, after, PAGE],
      );
      if (!page.rows.length) break;
      for (const entry of page.rows) {
        const seq = Number(entry.event_seq);
        if (seq !== bodies.length + 1) throw badRequest('云端事件流不连续，不能验证检查点');
        bodies.push(entry.body);
        after = seq;
      }
    }
    if (bodies.length !== eventCount) throw badRequest('云端事件流不连续，不能验证检查点');
    const events = bodies.map(asPlayerEvent);
    let snapshot;
    try {
      snapshot = exportReplay(replayEvents(libraryLoader(input.library), events), input.library.version, bodies);
    } catch {
      throw rejected('云端事件无法按播放器重放，检查点未写入');
    }
    if (snapshot.eventHash !== replayPrefixHash(input.library.version, bodies)) {
      throw rejected('事件前缀摘要不一致');
    }
    if (input.claimed !== undefined) {
      const version = input.claimed && typeof input.claimed === 'object' && 'projectorVersion' in input.claimed
        ? String((input.claimed as { projectorVersion?: unknown }).projectorVersion ?? '')
        : '';
      if (classifyProjector(version) !== 'replay') {
        throw unsupported('旧的有损投影或未知算法不能当作服务端检查点');
      }
      if (stableStringify(input.claimed) !== stableStringify(snapshot)) {
        throw rejected('客户端检查点与原始事件重放不一致');
      }
    }
    const canonical = stableStringify(snapshot);
    const digest = createHash('sha256').update(canonical).digest('hex');
    const inline = Buffer.byteLength(canonical) <= REPLAY_SNAPSHOT_INLINE_BYTES;
    const inserted = await q.query<{ snapshot_digest: string }>(
      `INSERT INTO replay_checkpoints (
         account_id, workspace_id, stream_id, event_count, event_hash,
         projector_version, snapshot_digest, snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (account_id, workspace_id, stream_id, event_count) DO NOTHING
       RETURNING snapshot_digest`,
      [
        accountId, input.workspaceId, input.streamId, eventCount, snapshot.eventHash,
        snapshot.projectorVersion, digest, inline ? canonical : null,
      ],
    );
    if (!inserted.rows[0]) {
      const existing = await q.query<{ snapshot_digest: string }>(
        `SELECT snapshot_digest FROM replay_checkpoints
         WHERE account_id = $1 AND workspace_id = $2 AND stream_id = $3 AND event_count = $4`,
        [accountId, input.workspaceId, input.streamId, eventCount],
      );
      if (existing.rows[0]?.snapshot_digest !== digest) {
        throw new CloudError(409, 'SYNC_CONFLICT', 'sync', '同一历史前缀已经有不同的检查点，不会覆盖');
      }
    }
    return { eventCount, eventHash: snapshot.eventHash, digest, inline };
  }
}
