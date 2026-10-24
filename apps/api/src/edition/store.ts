/**
 * Edition 的本机持久化（设计文档 §13.1）。
 *
 * 用内置 `node:sqlite`：对象不可变、任务与尝试逐条落库、取消与恢复都从磁盘读。
 * 三条纪律：
 * 1. 长 LLM/HTTP 调用**不持有**数据库写事务；先提交 `reserved`/`call_started`，
 *    调用结束再提交结果。
 * 2. 不设「第 201 条就写不进」的业务上限；热索引可以有界，持久记录不设总数上限。
 * 3. 崩溃恢复只标记，不自动重放外部调用。
 */
import { mkdirSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { edition } from '@endless/content';

type CompileJob = edition.CompileJob;
type IssueRelease = edition.IssueRelease;
type UnitRevision = edition.UnitRevision;

export const EDITION_DB_SCHEMA_VERSION = 1 as const;

export interface ObjectRecord {
  digest: string;
  type: string;
  id: string;
  body: unknown;
  createdAt: string;
}

export interface EditionRecord {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  headEditorialRevisionId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** 研究/编辑状态由更细的对象承载，这里只放概况。 */
  status: 'research' | 'planned' | 'compiling' | 'review' | 'published' | 'blocked';
  cefr: string | null;
  /** 未配置搜索服务时明确记下「不可用」，不假装搜索过。 */
  searchAvailable: boolean;
}

export interface JobRecordRow {
  job: CompileJob;
  /** 任务提交时的参考版本，用于「继续缺失单元」时判断依据是否已变化。 */
  expectedProjectRevision: number;
  intent: string;
  unitIds: string[];
  approvalDigest: string;
}

export interface AttemptRow {
  seq: number;
  jobId: string;
  unitId: string;
  workKey: string;
  status: 'reserved' | 'call_started' | 'result_saved' | 'failed' | 'unknown';
  startedAt: string;
  endedAt: string | null;
  failureCode: string | null;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = FULL;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS objects (
  digest TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS objects_type_id ON objects (type, id);

CREATE TABLE IF NOT EXISTS editions (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  edition_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  task_digest TEXT NOT NULL,
  editorial_revision_id TEXT,
  status TEXT NOT NULL,
  body TEXT NOT NULL,
  expected_revision INTEGER NOT NULL,
  intent TEXT NOT NULL,
  unit_ids TEXT NOT NULL,
  approval_digest TEXT NOT NULL,
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status);

CREATE TABLE IF NOT EXISTS attempts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  work_key TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  failure_code TEXT
);
CREATE INDEX IF NOT EXISTS attempts_job ON attempts (job_id, seq);
-- 同一 workKey 不允许两个未结束的尝试：并发提交必须在写盘层被挡住
CREATE UNIQUE INDEX IF NOT EXISTS attempts_open_work_key
  ON attempts (work_key) WHERE status IN ('reserved', 'call_started');

CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  edition_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  cefr TEXT NOT NULL,
  status TEXT NOT NULL,
  body TEXT NOT NULL,
  published_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS releases_current_issue_level
  ON releases (edition_id, issue_id, cefr) WHERE status = 'published';

CREATE TABLE IF NOT EXISTS approvals (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  edition_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS approvals_target ON approvals (edition_id, target_type, target_id, seq);

CREATE TABLE IF NOT EXISTS imports (
  id TEXT PRIMARY KEY,
  format TEXT NOT NULL,
  quarantined INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

function nowIso() {
  return new Date().toISOString();
}

/**
 * 本机 Edition 数据库。所有方法同步执行；调用方负责不要在网络调用期间持有事务。
 * `:memory:` 可用于测试，行为与文件库一致（包括唯一约束与 WAL 语义）。
 */
export class EditionStore {
  readonly db: DatabaseSync;
  private depth = 0;

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // 外部进程（另一个 API 实例、sqlite CLI）持写锁时先等一会儿，而不是立刻 503
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(SCHEMA);
    this.db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)')
      .run('schema_version', String(EDITION_DB_SCHEMA_VERSION));
    this.migrate();
  }

  /** 旧库补列：只做向后兼容的加法，不重建表、不丢记录。 */
  private migrate() {
    const columns = this.db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'failure_code')) {
      this.db.exec('ALTER TABLE jobs ADD COLUMN failure_code TEXT');
    }
    this.db.exec('DROP INDEX IF EXISTS releases_current_issue');
  }

  close() {
    if (this.depth) throw new Error('事务未结束，不能关闭数据库');
    this.db.close();
  }

  schemaVersion(): number {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  /** 显式事务：只包住纯数据库操作，绝不跨外部调用。 */
  transaction<T>(operation: () => T): T {
    if (this.depth) return operation();
    try {
      this.db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      if (/busy|locked/i.test((error as Error)?.message ?? '')) throw new EditionStoreBusyError();
      throw error;
    }
    this.depth += 1;
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* 回滚失败时保留原错误 */ }
      throw error;
    } finally {
      this.depth -= 1;
    }
  }

  // ---------- 不可变对象 ----------

  putObject(type: string, id: string, digest: string, body: unknown): void {
    this.db.prepare('INSERT OR IGNORE INTO objects (digest, type, id, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(digest, type, id, JSON.stringify(body), nowIso());
  }

  getObject(digest: string): ObjectRecord | null {
    const row = this.db.prepare('SELECT digest, type, id, body, created_at FROM objects WHERE digest = ?').get(digest) as
      { digest: string; type: string; id: string; body: string; created_at: string } | undefined;
    if (!row) return null;
    return { digest: row.digest, type: row.type, id: row.id, body: JSON.parse(row.body), createdAt: row.created_at };
  }

  objectsById(type: string, id: string): ObjectRecord[] {
    const rows = this.db.prepare('SELECT digest FROM objects WHERE type = ? AND id = ? ORDER BY created_at, digest')
      .all(type, id) as { digest: string }[];
    return rows.map((row) => this.getObject(row.digest)!);
  }

  listObjects(type: string, limit = 200, offset = 0): ObjectRecord[] {
    const rows = this.db.prepare('SELECT digest, type, id, body, created_at FROM objects WHERE type = ? ORDER BY created_at, digest LIMIT ? OFFSET ?')
      .all(type, limit, offset) as { digest: string; type: string; id: string; body: string; created_at: string }[];
    return rows.map((row) => ({ digest: row.digest, type: row.type, id: row.id, body: JSON.parse(row.body), createdAt: row.created_at }));
  }

  countObjects(type: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS total FROM objects WHERE type = ?').get(type) as { total: number };
    return Number(row.total);
  }

  /** 按 ID 批量取单元：导出不能只取第一页，否则大项目会悄悄丢单元。 */
  getUnitsByIds(ids: readonly string[]): ObjectRecord[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db.prepare(`SELECT digest, type, id, body, created_at FROM objects
      WHERE type = 'unit' AND id IN (${placeholders}) ORDER BY created_at, digest`).all(...ids) as
      { digest: string; type: string; id: string; body: string; created_at: string }[];
    const byId = new Map<string, ObjectRecord>();
    for (const row of rows) {
      const existing = byId.get(row.id);
      // 同一单元 ID 出现两个摘要说明数据不一致：宁可报错也不能随机取一条
      if (existing && existing.digest !== row.digest) {
        throw new Error(`单元 ${row.id} 存在多个摘要，数据不一致；请先修复再导出`);
      }
      byId.set(row.id, { digest: row.digest, type: row.type, id: row.id, body: JSON.parse(row.body), createdAt: row.created_at });
    }
    return ids.map((id) => byId.get(id)).filter((record): record is ObjectRecord => !!record);
  }

  putUnit(unit: UnitRevision): void {
    this.putObject('unit', unit.id, unit.digest, unit);
  }

  // ---------- 编辑项目 ----------

  putEdition(record: EditionRecord, expectedRevision?: number): EditionRecord {
    return this.transaction(() => {
      const existing = this.getEdition(record.id);
      if (expectedRevision !== undefined && (existing?.revision ?? 0) !== expectedRevision) {
        throw new EditionConflictError(`编辑项目已被其他操作更新（期望 ${expectedRevision}，实际 ${existing?.revision ?? 0}）`);
      }
      const next: EditionRecord = {
        ...record,
        revision: (existing?.revision ?? 0) + 1,
        createdAt: existing?.createdAt ?? record.createdAt ?? nowIso(),
        updatedAt: nowIso(),
      };
      this.db.prepare(`INSERT INTO editions (id, revision, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, body = excluded.body, updated_at = excluded.updated_at`)
        .run(next.id, next.revision, JSON.stringify(next), next.createdAt, next.updatedAt);
      return next;
    });
  }

  getEdition(id: string): EditionRecord | null {
    const row = this.db.prepare('SELECT body FROM editions WHERE id = ?').get(id) as { body: string } | undefined;
    return row ? JSON.parse(row.body) as EditionRecord : null;
  }

  listEditions(limit = 50, offset = 0): EditionRecord[] {
    const rows = this.db.prepare('SELECT body FROM editions ORDER BY updated_at DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as { body: string }[];
    return rows.map((row) => JSON.parse(row.body) as EditionRecord);
  }

  // ---------- 任务与尝试 ----------

  createJob(row: JobRecordRow): JobRecordRow {
    return this.transaction(() => {
      const existing = this.findJobByRequest(row.job.requestId);
      if (existing) {
        if (existing.job.taskDigest !== row.job.taskDigest) {
          throw new EditionConflictError('同一 requestId 已绑定到不同依据；请用新的请求 ID 重新提交');
        }
        return existing;
      }
      this.db.prepare(`INSERT INTO jobs
        (id, request_id, edition_id, kind, task_digest, editorial_revision_id, status, body, expected_revision, intent, unit_ids, approval_digest, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          row.job.id, row.job.requestId, row.job.editionId, row.job.kind, row.job.taskDigest,
          row.job.editorialRevisionId, row.job.status, JSON.stringify(row.job), row.expectedProjectRevision,
          row.intent, JSON.stringify(row.unitIds), row.approvalDigest, row.job.createdAt, row.job.updatedAt,
        );
      return row;
    });
  }

  updateJob(job: CompileJob, failureCode: string | null = null): void {
    // 成功/重试路径必须把上一次的失败码清掉，否则任务会一直背着旧原因
    this.db.prepare('UPDATE jobs SET status = ?, body = ?, updated_at = ?, failure_code = ? WHERE id = ?')
      .run(job.status, JSON.stringify(job), job.updatedAt, failureCode, job.id);
  }

  /** 任务级失败原因：即使没有尝试记录（预留写盘失败、执行槽忙）也能解释。 */
  jobFailureCode(id: string): string | null {
    const row = this.db.prepare('SELECT failure_code FROM jobs WHERE id = ?').get(id) as
      { failure_code: string | null } | undefined;
    return row?.failure_code ?? null;
  }

  getJob(id: string): JobRecordRow | null {
    const row = this.db.prepare(`SELECT body, expected_revision, intent, unit_ids, approval_digest FROM jobs WHERE id = ?`).get(id) as
      { body: string; expected_revision: number; intent: string; unit_ids: string; approval_digest: string } | undefined;
    if (!row) return null;
    return {
      job: JSON.parse(row.body) as CompileJob,
      expectedProjectRevision: Number(row.expected_revision),
      intent: row.intent,
      unitIds: JSON.parse(row.unit_ids) as string[],
      approvalDigest: row.approval_digest,
    };
  }

  findJobByRequest(requestId: string): JobRecordRow | null {
    const row = this.db.prepare('SELECT id FROM jobs WHERE request_id = ?').get(requestId) as { id: string } | undefined;
    return row ? this.getJob(row.id) : null;
  }

  listJobs(editionId: string, limit = 50): CompileJob[] {
    const rows = this.db.prepare('SELECT body FROM jobs WHERE edition_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(editionId, limit) as { body: string }[];
    return rows.map((row) => JSON.parse(row.body) as CompileJob);
  }

  /** 未结束的 queued/running：服务重启后统一标记 interrupted。 */
  listUnfinishedJobs(): CompileJob[] {
    const rows = this.db.prepare("SELECT body FROM jobs WHERE status IN ('queued', 'running', 'cancel_requested')")
      .all() as { body: string }[];
    return rows.map((row) => JSON.parse(row.body) as CompileJob);
  }

  reserveAttempt(row: Omit<AttemptRow, 'seq' | 'endedAt'>): AttemptRow {
    const result = this.db.prepare(`INSERT INTO attempts (job_id, unit_id, work_key, status, started_at, ended_at, failure_code)
      VALUES (?, ?, ?, ?, ?, NULL, NULL)`).run(row.jobId, row.unitId, row.workKey, row.status, row.startedAt);
    return { ...row, seq: Number(result.lastInsertRowid), endedAt: null };
  }

  markAttempt(seq: number, status: AttemptRow['status'], failureCode: string | null = null): void {
    this.db.prepare('UPDATE attempts SET status = ?, ended_at = ?, failure_code = ? WHERE seq = ?')
      .run(status, status === 'reserved' || status === 'call_started' ? null : nowIso(), failureCode, seq);
  }

  listAttempts(jobId: string): AttemptRow[] {
    const rows = this.db.prepare('SELECT seq, job_id, unit_id, work_key, status, started_at, ended_at, failure_code FROM attempts WHERE job_id = ? ORDER BY seq')
      .all(jobId) as { seq: number; job_id: string; unit_id: string; work_key: string; status: AttemptRow['status']; started_at: string; ended_at: string | null; failure_code: string | null }[];
    return rows.map((row) => ({
      seq: Number(row.seq), jobId: row.job_id, unitId: row.unit_id, workKey: row.work_key,
      status: row.status, startedAt: row.started_at, endedAt: row.ended_at, failureCode: row.failure_code,
    }));
  }

  /** 成功过的单元：继续任务时只跳过这些，不重复计费。 */
  successfulUnits(jobId: string): string[] {
    const rows = this.db.prepare("SELECT DISTINCT unit_id FROM attempts WHERE job_id = ? AND status = 'result_saved'")
      .all(jobId) as { unit_id: string }[];
    return rows.map((row) => row.unit_id);
  }

  /**
   * 同一依据下已经成功的单元：普通「继续」只补缺失部分，不重复计费。
   * 依据不同（新编辑修订、新语料、新等级）时不会命中，必须重新生成。
   */
  successfulUnitsForBasis(job: CompileJob): string[] {
    const rows = this.db.prepare(`SELECT a.unit_id, j.body FROM attempts a JOIN jobs j ON j.id = a.job_id
      WHERE a.status = 'result_saved' AND j.edition_id = ?
        AND j.editorial_revision_id IS ? AND j.kind = ?`)
      .all(job.editionId, job.editorialRevisionId, job.kind) as { unit_id: string; body: string }[];
    return [...new Set(rows.filter((row) => {
      const previous = JSON.parse(row.body) as CompileJob;
      return previous.cefr === job.cefr && previous.issuePlanId === job.issuePlanId;
    }).map((row) => row.unit_id))];
  }

  countAttempts(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS total FROM attempts').get() as { total: number };
    return Number(row.total);
  }

  // ---------- 发行与审批 ----------

  putRelease(release: IssueRelease): void {
    this.transaction(() => {
      const previous = this.getRelease(release.id);
      if (previous) {
        if (edition.canonicalJson(previous) !== edition.canonicalJson(release)) {
          throw new EditionConflictError('已发行版本不可覆盖或重新激活；更正必须创建新发行');
        }
        return;
      }
      if (release.status === 'published') {
        const current = this.db.prepare(`SELECT id FROM releases
          WHERE edition_id = ? AND issue_id = ? AND cefr = ? AND status = 'published'`)
          .get(release.editionId, release.issueId, release.cefr) as { id: string } | undefined;
        if ((current?.id ?? null) !== release.supersedes) {
          throw new EditionConflictError('更正必须明确取代同一期同等级的当前发行');
        }
        if (current) {
          this.db.prepare(`UPDATE releases SET status = 'superseded',
            body = json_set(body, '$.status', 'superseded', '$.supersededBy', ?)
            WHERE id = ?`).run(release.id, current.id);
        }
      }
      this.db.prepare(`INSERT INTO releases (id, edition_id, issue_id, cefr, status, body, published_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(release.id, release.editionId, release.issueId, release.cefr, release.status, JSON.stringify(release), release.publishedAt);
    });
  }

  getRelease(id: string): IssueRelease | null {
    const row = this.db.prepare('SELECT body FROM releases WHERE id = ?').get(id) as { body: string } | undefined;
    return row ? JSON.parse(row.body) as IssueRelease : null;
  }

  listReleases(editionId: string): IssueRelease[] {
    const rows = this.db.prepare('SELECT body FROM releases WHERE edition_id = ? ORDER BY published_at DESC')
      .all(editionId) as { body: string }[];
    return rows.map((row) => JSON.parse(row.body) as IssueRelease);
  }

  addApproval(input: {
    editionId: string; targetType: 'sources' | 'plan' | 'issue'; targetId: string;
    digest: string; reviewer: string; note?: string;
  }): void {
    this.db.prepare('INSERT INTO approvals (edition_id, target_type, target_id, digest, reviewer, approved_at, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(input.editionId, input.targetType, input.targetId, input.digest, input.reviewer, nowIso(), input.note ?? null);
  }

  latestApproval(editionId: string, targetType: string, targetId: string): { digest: string; reviewer: string; approvedAt: string } | null {
    const row = this.db.prepare(`SELECT digest, reviewer, approved_at FROM approvals
      WHERE edition_id = ? AND target_type = ? AND target_id = ? ORDER BY seq DESC LIMIT 1`)
      .get(editionId, targetType, targetId) as { digest: string; reviewer: string; approved_at: string } | undefined;
    return row ? { digest: row.digest, reviewer: row.reviewer, approvedAt: row.approved_at } : null;
  }

  // ---------- 导入暂存 ----------

  putImport(input: { id: string; format: string; quarantined: boolean; body: unknown }): void {
    this.db.prepare('INSERT OR REPLACE INTO imports (id, format, quarantined, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.id, input.format, input.quarantined ? 1 : 0, JSON.stringify(input.body), nowIso());
  }

  getImport(id: string): { id: string; format: string; quarantined: boolean; body: unknown } | null {
    const row = this.db.prepare('SELECT id, format, quarantined, body FROM imports WHERE id = ?').get(id) as
      { id: string; format: string; quarantined: number; body: string } | undefined;
    return row ? { id: row.id, format: row.format, quarantined: row.quarantined === 1, body: JSON.parse(row.body) } : null;
  }

  // ---------- 健康检查 ----------

  stats(): { objects: number; editions: number; jobs: number; attempts: number; releases: number; bytes: number } {
    const count = (table: string) => Number((this.db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }).total);
    const pages = this.db.prepare('PRAGMA page_count').get() as { page_count: number } | undefined;
    const size = this.db.prepare('PRAGMA page_size').get() as { page_size: number } | undefined;
    return {
      objects: count('objects'), editions: count('editions'), jobs: count('jobs'),
      attempts: count('attempts'), releases: count('releases'),
      bytes: Number(pages?.page_count ?? 0) * Number(size?.page_size ?? 0),
    };
  }

  /**
   * 磁盘水位：低容量时停止新工作，不自动删正文或失败记录。
   * 用 `statfs` 读真实可用空间，不用「查一次数据库」冒充检查。
   */
  assertWritable(minFreeBytes = MIN_FREE_BYTES): { freeBytes: number | null } {
    if (this.path === ':memory:') return { freeBytes: null };
    let freeBytes: number | null = null;
    try {
      const stats = statfsSync(dirname(this.path));
      freeBytes = Number(stats.bavail) * Number(stats.bsize);
    } catch {
      // 取不到文件系统信息时不假装磁盘充足，也不阻止只读查看
      return { freeBytes: null };
    }
    if (freeBytes !== null && freeBytes < minFreeBytes) {
      throw new EditionStorageLowError(freeBytes, minFreeBytes);
    }
    return { freeBytes };
  }
}

/** 本机磁盘不足：停止新任务，给出体积与备份建议，不自动删正文。 */
export const MIN_FREE_BYTES = 64 * 1024 * 1024;

export class EditionConflictError extends Error {}

export class EditionStorageLowError extends Error {
  constructor(readonly freeBytes: number, readonly requiredBytes: number) {
    super(`本机磁盘可用空间约 ${Math.round(freeBytes / 1024 / 1024)} MB，低于 ${Math.round(requiredBytes / 1024 / 1024)} MB 水位；请先备份或清理后再开始编纂`);
  }
}

/** 本机 SQLite 被外部进程持有写锁：本次未写入，可稍后重试（不是数据错误）。 */
export class EditionStoreBusyError extends Error {
  constructor(message = '本机 Edition 数据库正被另一个进程占用；本次未写入，可稍后重试') {
    super(message);
    this.name = 'EditionStoreBusyError';
  }
}

export function isEditionRef(value: unknown): value is string {
  return typeof value === 'string' && /^(edn|edr|crp|iss|unt|ulv|urv|lpk|rdc|src|snp|spn|clm|psg|run|rvr|evt|job)_[0-9a-f-]{36}$/.test(value);
}
