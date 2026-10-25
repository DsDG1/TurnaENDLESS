/**
 * 本机 Edition API（设计文档 §14）。
 *
 * 路由本身不做业务判断：校验参数与 capability、限流限额、把结果交给
 * `EditionStore` / `EditionJobManager`。所有状态变更都要求合法 Origin，
 * 对象读取也要求 capability，防止任意网页窃取本机资料。
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { edition } from '@endless/content';
import { EditionConflictError, EditionStore, EditionStoreBusyError, isEditionRef } from './store.js';
import { EditionJobError, EditionJobManager } from './jobs.js';
import { editionRunnerCapabilities, putDraftUnit, verifyReleaseForPublication, type DraftUnitRecord } from './runner.js';

const CONTROL_LIMIT = 1 * 1024 * 1024;
const IMPORT_LIMIT = 8 * 1024 * 1024;
const EXPORT_LIMIT = 8 * 1024 * 1024;
const MAX_PAGE = 100;

export interface EditionRouterOptions {
  store: EditionStore;
  jobs: EditionJobManager;
  /** 合法页面来源；capability 由组合根统一校验，这里只复核变更类请求的 Origin。 */
  origins: readonly string[];
  searchAvailable?: boolean;
}

function send(response: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  response.end(text);
}

async function readJson(request: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) throw new EditionJobError(413, '请求体超过 Edition 接口上限');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new EditionJobError(400, '请求不是有效的 JSON 对象');
  }
}

function stringField(body: Record<string, unknown>, key: string, max = 200): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new EditionJobError(400, `字段 ${key} 缺失或超长`);
  }
  return value.trim();
}

function intField(body: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = body[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new EditionJobError(400, `字段 ${key} 必须是 ${min}–${max} 的整数`);
  }
  return value;
}

function page(url: URL): { limit: number; offset: number } {
  const limit = Math.min(MAX_PAGE, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20));
  const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0);
  return { limit, offset };
}

/**
 * 返回 `handled=false` 表示不是 Edition 路由，交回原有 ENDLESS 分发。
 * Origin/Host/capability 由组合根统一校验；这里再校验一次状态变更的 Origin，
 * 避免未来把路由挂到别处时忘记。
 */
export function createEditionRouter(options: EditionRouterOptions) {
  const { store, jobs, origins } = options;

  return async function handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    if (!path.startsWith('/api/edition')) return false;

    const method = request.method ?? 'GET';
    const requireOrigin = () => {
      if (!request.headers.origin || !origins.includes(request.headers.origin)) {
        throw new EditionJobError(403, '缺少合法的页面来源');
      }
    };
    const requireJson = () => {
      if (!request.headers['content-type']?.startsWith('application/json')) {
        throw new EditionJobError(415, '仅接受 application/json');
      }
    };

    try {
      // ---------- 状态 ----------
      if (method === 'GET' && path === '/api/edition-status') {
        send(response, 200, {
          contract: edition.EDITION_CONTRACT,
          schemaVersion: store.schemaVersion(),
          stats: store.stats(),
          searchAvailable: options.searchAvailable ?? false,
          capabilities: editionRunnerCapabilities,
          prompts: edition.EDITION_PROMPT_VERSION,
          limits: {
            controlBytes: CONTROL_LIMIT,
            importBytes: IMPORT_LIMIT,
            exportBytes: EXPORT_LIMIT,
            page: MAX_PAGE,
          },
        });
        return true;
      }

      // ---------- 编辑项目 ----------
      if (method === 'POST' && path === '/api/editions') {
        requireOrigin();
        requireJson();
        const body = await readJson(request, CONTROL_LIMIT);
        const now = new Date().toISOString();
        const cefrRaw = body.cefr;
        const cefr = cefrRaw === undefined ? null : edition.CefrSchema.parse(cefrRaw);
        if (cefr && !edition.isOpenLevel(cefr)) {
          throw new EditionJobError(409, `${cefr} 尚未开放；当前只开放 ${edition.OPEN_CEFR_LEVELS.join('、')}`);
        }
        const record = store.putEdition({
          id: `edn_${randomUUID()}`,
          title: stringField(body, 'title', 120),
          subtitle: typeof body.subtitle === 'string' ? body.subtitle.slice(0, 160) : '',
          description: typeof body.description === 'string' ? body.description.slice(0, 500) : '',
          headEditorialRevisionId: null,
          revision: 0,
          createdAt: now,
          updatedAt: now,
          status: 'research',
          cefr,
          searchAvailable: options.searchAvailable ?? false,
        });
        send(response, 201, record);
        return true;
      }

      const editionMatch = /^\/api\/editions\/([a-z0-9_:-]+)$/.exec(path);
      if (editionMatch && method === 'GET') {
        const id = editionMatch[1]!;
        if (!isEditionRef(id)) throw new EditionJobError(400, '编辑项目 ID 不合法');
        const record = store.getEdition(id);
        if (!record) throw new EditionJobError(404, '找不到编辑项目');
        const { limit, offset } = page(url);
        const releases = store.listReleases(id).map((release) => ({
          id: release.id,
          issueId: release.issueId,
          cefr: release.cefr,
          status: release.status,
          digest: release.digest,
          publishedAt: release.publishedAt,
        }));
        const jobRows = store.listJobs(id, limit);
        send(response, 200, {
          edition: record,
          jobs: jobRows.map((job) => ({
            id: job.id, kind: job.kind, status: job.status,
            attempts: job.attempts.length, updatedAt: job.updatedAt,
            failure: jobs.describeFailure(job),
          })),
          releases,
          page: { limit, offset },
        });
        return true;
      }

      // ---------- 任务 ----------
      const submitMatch = /^\/api\/editions\/([a-z0-9_:-]+)\/jobs$/.exec(path);
      if (submitMatch && method === 'POST') {
        requireOrigin();
        requireJson();
        const editionId = submitMatch[1]!;
        if (!isEditionRef(editionId)) throw new EditionJobError(400, '编辑项目 ID 不合法');
        const body = await readJson(request, CONTROL_LIMIT);
        const kind = edition.CompileJobKindSchema.parse(body.kind);
        const unitIds = Array.isArray(body.unitIds) ? body.unitIds : [];
        if (!unitIds.length || unitIds.length > 20 ||
            unitIds.some((id) => typeof id !== 'string' || !isEditionRef(id))) {
          throw new EditionJobError(400, 'unitIds 必须是 1–20 个合法 Edition 对象 ID');
        }
        if (new Set(unitIds).size !== unitIds.length) {
          throw new EditionJobError(400, 'unitIds 不能重复');
        }
        const editorialRevisionId = body.editorialRevisionId === null || body.editorialRevisionId === undefined
          ? null : stringField(body, 'editorialRevisionId');
        const issuePlanId = body.issuePlanId === null || body.issuePlanId === undefined
          ? null : stringField(body, 'issuePlanId');
        const cefr = body.cefr === null || body.cefr === undefined ? null : edition.CefrSchema.parse(body.cefr);
        // 页面 Key 只允许出现在需要模型的提交请求头里；不落库、不回显、不进导出
        const suppliedKey = request.headers['x-endless-provider-key'];
        if (suppliedKey !== undefined && (typeof suppliedKey !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(suppliedKey))) {
          throw new EditionJobError(400, 'API Key 格式不正确；不会保存或回显密钥');
        }
        const row = jobs.submit({
          requestId: stringField(body, 'requestId', 80),
          kind,
          editionId,
          editorialRevisionId,
          issuePlanId,
          cefr,
          unitIds: unitIds as string[],
          intent: stringField(body, 'intent', 40),
          expectedProjectRevision: intField(body, 'expectedProjectRevision', 0, 1_000_000),
          approvedTaskDigest: stringField(body, 'approvedTaskDigest', 80),
          apiKey: suppliedKey,
        });
        send(response, row.job.status === 'queued' || row.job.status === 'running' ? 202 : 200, row.job);
        return true;
      }

      // ---------- 已批准草稿登记 ----------
      const draftMatch = /^\/api\/editions\/([a-z0-9_:-]+)\/drafts$/.exec(path);
      if (draftMatch && method === 'POST') {
        requireOrigin();
        requireJson();
        const editionId = draftMatch[1]!;
        if (!isEditionRef(editionId)) throw new EditionJobError(400, '编辑项目 ID 不合法');
        if (!store.getEdition(editionId)) throw new EditionJobError(404, '找不到编辑项目');
        const body = await readJson(request, IMPORT_LIMIT);
        const unitId = stringField(body, 'unitId', 80);
        const revision = edition.UnitRevisionSchema.parse(body.revision);
        if (revision.unitId !== unitId) throw new EditionJobError(400, 'unitId 与修订不一致');
        if (revision.basis.editionId !== editionId) throw new EditionJobError(400, '修订不属于该编辑项目');
        const context = body.context as DraftUnitRecord['context'] | undefined;
        if (!context || typeof context !== 'object' || Array.isArray(context)) {
          throw new EditionJobError(400, '缺少草稿复核依据（context）');
        }
        if (context.editorial?.id && context.editorial.id !== revision.basis.editorialRevisionId) {
          throw new EditionJobError(400, '草稿依据与修订的目录不一致');
        }
        // 这里只做结构登记；完整复核（重编译 + 逐项比对 + 目录审批摘要）在 compile_issue 执行器里
        putDraftUnit(store, unitId, { revision, context });
        send(response, 201, { unitId, revisionId: revision.id, digest: revision.digest });
        return true;
      }

      const jobMatch = /^\/api\/edition-jobs\/([a-z0-9_:-]+)$/.exec(path);
      if (jobMatch && method === 'GET') {
        const row = store.getJob(jobMatch[1]!);
        if (!row) throw new EditionJobError(404, '找不到编纂任务；请使用原任务 ID 恢复');
        send(response, 200, { job: row.job, failure: jobs.describeFailure(row.job) });
        return true;
      }

      const cancelMatch = /^\/api\/edition-jobs\/([a-z0-9_:-]+)\/cancel$/.exec(path);
      if (cancelMatch && method === 'POST') {
        requireOrigin();
        const job = jobs.cancel(cancelMatch[1]!);
        send(response, 200, {
          job,
          note: '取消只设持久标志并尽力中止当前请求；不承诺供应商停止或退费，已保存的单元保留。',
        });
        return true;
      }

      // ---------- 审批 ----------
      const approvalMatch = /^\/api\/editions\/([a-z0-9_:-]+)\/approvals$/.exec(path);
      if (approvalMatch && method === 'POST') {
        requireOrigin();
        requireJson();
        const editionId = approvalMatch[1]!;
        const body = await readJson(request, CONTROL_LIMIT);
        const targetType = stringField(body, 'targetType', 20);
        if (!['sources', 'plan', 'issue'].includes(targetType)) {
          throw new EditionJobError(400, 'targetType 只能是 sources / plan / issue');
        }
        const targetId = stringField(body, 'targetId', 80);
        if (!isEditionRef(targetId)) throw new EditionJobError(400, '审批目标 ID 不合法');
        const digest = stringField(body, 'digest', 80);
        if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new EditionJobError(400, '审批必须绑定 sha256 摘要');
        const record = store.getEdition(editionId);
        if (!record) throw new EditionJobError(404, '找不到编辑项目');
        const reviewer = typeof body.reviewer === 'string' && body.reviewer.trim() ? body.reviewer.slice(0, 80) : 'owner';
        if (reviewer === 'model') throw new EditionJobError(400, '模型不能作为审批者');
        store.addApproval({
          editionId, targetType: targetType as 'sources' | 'plan' | 'issue', targetId, digest, reviewer,
          note: typeof body.note === 'string' ? body.note.slice(0, 500) : undefined,
        });
        send(response, 201, { editionId, targetType, targetId, digest, reviewer });
        return true;
      }

      // ---------- 发布 ----------
      const releaseMatch = /^\/api\/editions\/([a-z0-9_:-]+)\/releases$/.exec(path);
      if (releaseMatch && method === 'POST') {
        requireOrigin();
        requireJson();
        const body = await readJson(request, CONTROL_LIMIT);
        const objectDigest = stringField(body, 'objectDigest', 80);
        const object = store.getObject(objectDigest);
        if (!object || object.type !== 'release') throw new EditionJobError(404, '找不到该发行对象');
        // 本机对象也不能直接信任：按契约 schema 复核后才允许进入发行表
        const parsedRelease = edition.IssueReleaseSchema.safeParse(object.body);
        if (!parsedRelease.success) throw new EditionJobError(422, '发行对象不符合契约，拒绝发布');
        const release = parsedRelease.data;
        if (release.editionId !== releaseMatch[1] || !store.getEdition(release.editionId)) {
          throw new EditionJobError(409, '发行不属于当前编辑项目');
        }
        if (object.id !== release.id || object.digest !== release.digest || release.status !== 'published') {
          throw new EditionJobError(422, '发行对象标识、摘要或状态不一致');
        }
        try {
          verifyReleaseForPublication(store, release);
        } catch {
          throw new EditionJobError(422, '发行缺少完整成稿或未通过依据、权利与重编译复核');
        }
        const approval = store.latestApproval(release.editionId, 'issue', release.issueId);
        if (!approval || approval.digest !== release.digest) {
          throw new EditionJobError(409, '成稿尚未按当前摘要审批，不能发布；审阅后正文再改一字也会失效');
        }
        store.putRelease(release);
        send(response, 201, { release });
        return true;
      }

      const manifestMatch = /^\/api\/edition-releases\/([a-z0-9_:-]+)\/manifest$/.exec(path);
      if (manifestMatch && method === 'GET') {
        const release = store.getRelease(manifestMatch[1]!);
        if (!release) throw new EditionJobError(404, '找不到发行版本');
        send(response, 200, release.manifest);
        return true;
      }

      // ---------- 对象 ----------
      const objectMatch = /^\/api\/edition-objects\/(sha256:[a-f0-9]{64})$/.exec(path);
      if (objectMatch && method === 'GET') {
        const record = store.getObject(objectMatch[1]!);
        if (!record) throw new EditionJobError(404, '本机没有登记该依赖对象');
        send(response, 200, { digest: record.digest, type: record.type, id: record.id, body: record.body });
        return true;
      }

      // ---------- 导入 / 导出 ----------
      if (path === '/api/edition-imports' && method === 'POST') {
        requireOrigin();
        requireJson();
        const body = await readJson(request, IMPORT_LIMIT);
        const text = stringField(body, 'text', IMPORT_LIMIT);
        let parsed;
        try {
          parsed = edition.parseContainer(text);
        } catch (error) {
          throw new EditionJobError(422, `包格式无法识别：${(error as Error).message}`);
        }
        // A file's self-declared "local" label is not evidence of local provenance.
        const quarantined = true;
        const id = `imp_${randomUUID()}`;
        store.putImport({ id, format: parsed.manifest.format, quarantined, body: parsed });
        send(response, quarantined ? 409 : 201, {
          id,
          quarantined,
          format: parsed.manifest.format,
          records: parsed.records.length,
          note: quarantined
            ? '来自未信任来源的包已暂存并隔离：即使哈希全部正确，也需要本地信任或授权审阅后才能导入'
            : '已暂存，未激活；导入需要单独的确认步骤',
        });
        return true;
      }

      const exportMatch = /^\/api\/editions\/([a-z0-9_:-]+)\/export$/.exec(path);
      if (exportMatch && method === 'GET') {
        const record = store.getEdition(exportMatch[1]!);
        if (!record) throw new EditionJobError(404, '找不到编辑项目');
        const releases = store.listReleases(record.id);
        // 按 ID 精确取单元：分页读会在大项目里悄悄丢单元，不能用于导出
        const unitIds = [...new Set(releases.flatMap((release) => release.orderedUnitRevisionIds))];
        const units = store.getUnitsByIds(unitIds);
        if (units.length !== unitIds.length) {
          throw new EditionJobError(422, '发行引用的单元修订不完整，拒绝导出缺单元的项目');
        }
        const payload = {
          contract: 'edition-project-export/1',
          exportedAt: new Date().toISOString(),
          edition: record,
          releases,
          units,
        };
        const text = JSON.stringify(payload);
        if (text.length > EXPORT_LIMIT) {
          throw new EditionJobError(413, '项目导出超过单次上限，请按发行版本分批导出');
        }
        response.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(text);
        return true;
      }

      throw new EditionJobError(404, 'Edition 接口不存在');
    } catch (error) {
      if (error instanceof EditionJobError) {
        send(response, error.status, { error: error.message, code: error.code ?? 'E-EDITION-API' });
      } else if (error instanceof EditionStoreBusyError) {
        send(response, 503, { error: error.message, code: 'E-EDITION-BUSY' });
      } else if (error instanceof EditionConflictError) {
        send(response, 409, { error: error.message, code: 'E-EDITION-CONFLICT' });
      } else if (error instanceof Error && /Zod|invalid|Invalid/i.test(`${error.name} ${error.message}`)) {
        send(response, 400, { error: '请求字段不合法', code: 'E-EDITION-VALIDATION' });
      } else {
        // 不把内部错误对象、堆栈或数据库路径回显给页面
        send(response, 503, { error: 'Edition 服务暂不可用；不会自动重试模型调用', code: 'E-EDITION-UNAVAILABLE' });
      }
      return true;
    }
  };
}
