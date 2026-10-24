/**
 * 编纂任务状态机（设计文档 §12）。
 *
 * 关键顺序：**先持久化预留，再调用供应商；先保存结果，再开始下一个单元**。
 * 崩溃发生在调用与保存之间时记 `unknown`，提示「可能已经计费」，绝不自动重放。
 * 取消只设持久标志，尽力中止当前请求，但不承诺供应商侧停止或退费。
 */
import { randomUUID } from 'node:crypto';
import { edition } from '@endless/content';

type Cefr = edition.Cefr;
type CompileJob = edition.CompileJob;
type CompileJobKind = edition.CompileJobKind;
type CompileJobStatus = edition.CompileJobStatus;
const { compileTaskDigest } = edition;
import { EditionConflictError, EditionStorageLowError, EditionStore, type AttemptRow, type JobRecordRow } from './store.js';
import { ExecutionBusyError, ExecutionGate } from '../execution-gate.js';

export class EditionJobError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export interface EditionUnitResult {
  objectType: string;
  objectId: string;
  objectDigest: string;
  body: unknown;
}

export interface EditionUnitContext {
  job: CompileJob;
  unitId: string;
  workKey: string;
  /** 只在本次任务内存里存在；不落库、不进日志、不进错误。 */
  apiKey: string | undefined;
  attempt: AttemptRow;
}

export type EditionUnitRunner = (context: EditionUnitContext) => Promise<EditionUnitResult>;

export interface SubmitInput {
  requestId: string;
  kind: CompileJobKind;
  editionId: string;
  editorialRevisionId: string | null;
  issuePlanId: string | null;
  cefr: Cefr | null;
  unitIds: string[];
  intent: string;
  expectedProjectRevision: number;
  approvedTaskDigest: string;
  apiKey?: string;
}

const MAX_ATTEMPTS_IN_JOB = 200;

function nowIso() {
  return new Date().toISOString();
}

function categorize(error: unknown): string {
  const chain: { statusCode?: number; name?: string }[] = [];
  let cause = error;
  while (cause && typeof cause === 'object' && chain.length < 4) {
    chain.push(cause as { statusCode?: number; name?: string });
    cause = (cause as { cause?: unknown }).cause;
  }
  const status = chain.find((entry) => entry.statusCode)?.statusCode;
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  if (chain.some((entry) => entry.name === 'EditorialModelUnavailableError')) return 'unconfigured';
  if (chain.some((entry) => entry.name === 'AbortError' || entry.name === 'TimeoutError')) return 'timeout';
  if (chain.some((entry) => entry.name === 'TypeError' || entry.name === 'FetchError')) return 'network';
  if (error instanceof Error && /校验|验收|复核|未通过|契约|compile|E-EDITION|EDITION-DRAFT/i.test(error.message)) return 'content';
  return 'unknown';
}

/** 安全错误文案：不含 provider body、网页原文、提示词、Key 或私人笔记。 */
function safeMessage(code: string): string {
  switch (code) {
    case 'auth': return '模型认证失败，请检查本次输入的 API Key 或服务端密钥与模型权限';
    case 'rate-limit': return '模型供应商限流或额度不足，请检查账户余额与限额，稍后手动重试';
    case 'timeout': return '模型响应超时，未自动重新调用；已完成单元仍保留';
    case 'network': return '连接模型供应商失败，请检查本机网络或代理；已完成单元仍保留';
    case 'content': return '生成内容未通过程序验收；已完成单元仍保留，未自动重试';
    case 'cancel': return '任务已取消；已完成的单元保留，取消不保证供应商停止或退费';
    default: return '编纂未完成；已完成单元仍保留，不会自动重新调用模型（可能产生费用）';
  }
}

export class EditionJobManager {
  private running = new Map<string, Promise<void>>();

  constructor(
    private store: EditionStore,
    private runner: EditionUnitRunner | null = null,
    private gate: ExecutionGate = new ExecutionGate(),
  ) {}

  /** 启动时只做标记：queued/running → interrupted；未结束的调用 → unknown。 */
  initialize(): { interrupted: number; unknown: number } {
    let interrupted = 0;
    let unknown = 0;
    for (const job of this.store.listUnfinishedJobs()) {
      for (const attempt of this.store.listAttempts(job.id)) {
        if (attempt.status === 'call_started') {
          this.store.markAttempt(attempt.seq, 'unknown', 'interrupted');
          unknown += 1;
        } else if (attempt.status === 'reserved') {
          this.store.markAttempt(attempt.seq, 'failed', 'interrupted');
        }
      }
      this.store.updateJob({
        ...job,
        status: 'interrupted',
        updatedAt: nowIso(),
        attempts: this.attemptWindow(job.id),
      });
      interrupted += 1;
    }
    return { interrupted, unknown };
  }

  private attemptWindow(jobId: string): CompileJob['attempts'] {
    const attempts = this.store.listAttempts(jobId);
    return attempts.slice(-MAX_ATTEMPTS_IN_JOB).map((attempt) => ({
      unitId: attempt.unitId as CompileJob['attempts'][number]['unitId'],
      workKey: attempt.workKey as CompileJob['attempts'][number]['workKey'],
      status: attempt.status,
      startedAt: attempt.startedAt,
      endedAt: attempt.endedAt,
      failureCode: attempt.failureCode,
    }));
  }

  get(id: string): JobRecordRow | null {
    return this.store.getJob(id);
  }

  /**
   * 提交：服务端重新计算 taskDigest 并与客户端「已批准」的摘要比对。
   * 不信任客户端传来的「已批准」布尔值，也不允许一次点击展开无穷后续任务。
   */
  submit(input: SubmitInput): JobRecordRow {
    const digest = compileTaskDigest({
      kind: input.kind, editionId: input.editionId, editorialRevisionId: input.editorialRevisionId,
      issuePlanId: input.issuePlanId, cefr: input.cefr, unitIds: input.unitIds, intent: input.intent,
    });
    if (digest !== input.approvedTaskDigest) {
      throw new EditionJobError(409, '任务依据与已批准的摘要不一致；请重新审阅后再提交', 'E-JOB-DIGEST');
    }
    const existing = this.store.findJobByRequest(input.requestId);
    if (existing) {
      if (existing.job.taskDigest !== digest) {
        throw new EditionJobError(409, '同一 requestId 已绑定到不同依据；请用新的请求 ID', 'E-JOB-REQUEST');
      }
      return existing;
    }
    try {
      this.store.assertWritable();
    } catch (error) {
      if (error instanceof EditionStorageLowError) throw new EditionJobError(507, error.message, 'E-JOB-STORAGE');
      throw error;
    }
    const edition = this.store.getEdition(input.editionId);
    if (!edition) throw new EditionJobError(404, '找不到编辑项目', 'E-JOB-EDITION');
    if (edition.revision !== input.expectedProjectRevision) {
      throw new EditionJobError(409, `编辑项目已更新（期望版本 ${input.expectedProjectRevision}，当前 ${edition.revision}）；请刷新后重新确认`, 'E-JOB-REVISION');
    }
    if (input.kind === 'compile_issue') {
      const approval = this.store.latestApproval(input.editionId, 'plan', input.editorialRevisionId ?? '');
      if (!approval) throw new EditionJobError(409, '目录尚未批准，不能开始正文编纂', 'E-JOB-APPROVAL');
    }
    const createdAt = nowIso();
    const job: CompileJob = {
      id: `job_${randomUUID()}`,
      requestId: input.requestId,
      kind: input.kind,
      editionId: input.editionId as CompileJob['editionId'],
      editorialRevisionId: (input.editorialRevisionId ?? null) as CompileJob['editorialRevisionId'],
      issuePlanId: (input.issuePlanId ?? null) as CompileJob['issuePlanId'],
      cefr: input.cefr,
      taskDigest: digest as CompileJob['taskDigest'],
      status: 'queued',
      attempts: [],
      resultRefs: [],
      createdAt,
      updatedAt: createdAt,
    };
    let row: JobRecordRow;
    try {
      row = this.store.createJob({
        job, expectedProjectRevision: input.expectedProjectRevision, intent: input.intent,
        unitIds: input.unitIds, approvalDigest: input.approvedTaskDigest,
      });
    } catch (error) {
      if (error instanceof EditionConflictError) throw new EditionJobError(409, error.message, 'E-JOB-CONFLICT');
      throw error;
    }
    if (row.job.status === 'queued') void this.start(row.job.id, input.apiKey);
    return row;
  }

  /** 取消：设置持久标志；当前请求尽力中止，后续单元不再开始。 */
  cancel(id: string): CompileJob {
    const row = this.store.getJob(id);
    if (!row) throw new EditionJobError(404, '找不到编纂任务', 'E-JOB-NOTFOUND');
    if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(row.job.status)) return row.job;
    const next: CompileJob = { ...row.job, status: 'cancel_requested', updatedAt: nowIso() };
    this.store.updateJob(next);
    return next;
  }

  /** 等待后台任务结束：只用于测试与优雅关闭，不用于轮询接口。 */
  async settle(id: string): Promise<void> {
    await this.running.get(id);
  }

  private async start(id: string, apiKey?: string) {
    if (this.running.has(id)) return;
    // 后台任务自己吞掉异常：settle() 只等待完成，不把内部错误抛给轮询方
    const task = this.execute(id, apiKey).catch(() => {}).finally(() => {
      this.running.delete(id);
      apiKey = undefined;
    });
    this.running.set(id, task);
    await task;
  }

  private async execute(id: string, apiKey?: string) {
    const row = this.store.getJob(id);
    if (!row) return;
    if (!this.runner) {
      this.fail(id, 'unconfigured');
      return;
    }
    try {
      this.gate.acquire('edition');
    } catch (error) {
      if (error instanceof ExecutionBusyError) {
        // 不排队、不后台偷跑：直接告诉用户当前有别的外部任务
        this.fail(id, 'busy');
        return;
      }
      throw error;
    }
    try {
      let job: CompileJob = { ...row.job, status: 'running', updatedAt: nowIso() };
      this.store.updateJob(job);
      // 「继续」按依据去重：同一编辑修订下已成功的单元不再调用，避免重复计费
      const done = new Set([
        ...this.store.successfulUnits(id),
        ...(row.intent === 'rewrite' ? [] : this.store.successfulUnitsForBasis(row.job)),
      ]);
      const pending = row.unitIds.filter((unitId) => !done.has(unitId));
      for (const unitId of pending) {
        const current = this.store.getJob(id)?.job ?? job;
        if (current.status === 'cancel_requested' || current.status === 'cancelled') {
          this.store.updateJob({ ...current, status: 'cancelled', updatedAt: nowIso(), attempts: this.attemptWindow(id) });
          return;
        }
        const project = this.store.getEdition(row.job.editionId);
        if (project?.revision !== row.expectedProjectRevision) {
          this.fail(id, 'basis-changed');
          return;
        }
        const workKey = edition.digestOf({
          kind: job.kind, editionId: job.editionId, editorialRevisionId: job.editorialRevisionId,
          issueId: job.issuePlanId, cefr: job.cefr, unitId,
          compiler: edition.EDITION_COMPILER_VERSION, policy: edition.EDITION_VALIDATION_POLICY_VERSION,
          intent: row.intent === 'continue_missing' ? 'initial' : row.intent,
        });
        // 1) 先写预留：写不进就绝不调用供应商，也不能留下「正在运行」的假象
        let attempt: AttemptRow;
        try {
          attempt = this.store.reserveAttempt({
            jobId: id, unitId, workKey, status: 'reserved', startedAt: nowIso(), failureCode: null,
          });
        } catch {
          this.fail(id, 'storage');
          return;
        }
        try {
          // 2) 再写 call_started：崩溃在调用与保存之间会留下 unknown
          this.store.markAttempt(attempt.seq, 'call_started');
          job = { ...current, status: 'running', updatedAt: nowIso() };
          this.store.updateJob(job);
        } catch {
          this.store.markAttempt(attempt.seq, 'failed', 'storage');
          this.fail(id, 'storage');
          return;
        }
        try {
          const result = await this.runner({
            job, unitId, workKey, apiKey,
            attempt: { ...attempt, status: 'call_started' },
          });
          // 3) 先保存结果，再开始下一个单元
          this.store.transaction(() => {
            this.store.putObject(result.objectType, result.objectId, result.objectDigest, result.body);
            this.store.markAttempt(attempt.seq, 'result_saved');
          });
          const latest = this.store.getJob(id)?.job ?? job;
          job = {
            ...latest,
            resultRefs: [...new Set([...latest.resultRefs, result.objectId])] as CompileJob['resultRefs'],
            updatedAt: nowIso(),
            attempts: this.attemptWindow(id),
          };
          this.store.updateJob(job);
        } catch (error) {
          const code = categorize(error);
          this.store.markAttempt(attempt.seq, 'failed', code);
          this.fail(id, code);
          return;
        }
      }
      const latest = this.store.getJob(id)?.job ?? job;
      this.store.updateJob({
        ...latest,
        status: latest.status === 'cancel_requested' ? 'cancelled' : 'succeeded',
        updatedAt: nowIso(),
        attempts: this.attemptWindow(id),
      });
    } finally {
      this.gate.release('edition');
      apiKey = undefined;
    }
  }

  private fail(id: string, code: string) {
    const row = this.store.getJob(id);
    if (!row) return;
    try {
      this.store.updateJob({
        ...row.job,
        status: 'failed',
        updatedAt: nowIso(),
        attempts: this.attemptWindow(id),
      }, code);
    } catch {
      // 写盘失败时不谎报成功；内存里也保留失败状态供本进程查询
      this.store.updateJob({ ...row.job, status: 'failed', updatedAt: nowIso() }, code);
    }
  }

  statusOf(job: CompileJob): CompileJobStatus {
    return job.status;
  }

  /** 供路由展示：失败原因与下一步建议分开写，不泄露内部错误对象。 */
  describeFailure(job: CompileJob): { code: string; message: string; next: string } | null {
    if (job.status !== 'failed' && job.status !== 'interrupted') return null;
    const attempt = [...job.attempts].reverse().find((entry) => entry.failureCode);
    const code = this.store.jobFailureCode(job.id)
      ?? attempt?.failureCode
      ?? (job.status === 'interrupted' ? 'interrupted' : 'unknown');
    return {
      code,
      message: code === 'interrupted'
        ? '服务端在编纂期间中断；已保存的单元保留，未完成的调用可能已经计费'
        : code === 'busy'
          ? '另一个外部任务正在运行；本次未开始，也不会在后台排队计费'
          : code === 'storage'
            ? '本机存储写入失败或空间不足；已保存单元保留，已开始的调用可能已经计费，不会自动重试'
            : code === 'basis-changed'
              ? '编纂依据已改变；已保存结果仍属于原依据，后续单元未开始，请重新审阅计划'
            : code === 'unconfigured'
              ? '服务端未配置编纂执行器；任务未开始，也没有调用任何外部服务'
              : safeMessage(code),
      next: '只对未完成单元手动重新提交；不要整期重跑，避免重复计费',
    };
  }
}
