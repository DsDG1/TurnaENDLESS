import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { GeneratedEpisodeSchema, GenerationFailureSchema, type GeneratedEpisode, type GenerationFailure } from '@endless/content';
import { stableStringify } from '@endless/esl';

export class ApiError extends Error {
  constructor(public status: number, message: string, public failure?: GenerationFailure) {
    super(message);
  }
}

const JobSchema = z.object({
  id: z.string().uuid(),
  payloadHash: z.string(),
  storyHash: z.string().optional(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  phase: z.string(),
  createdAt: z.string().datetime(),
  result: GeneratedEpisodeSchema.optional(),
  error: z.string().optional(),
  failure: GenerationFailureSchema.optional(),
});
export type JobRecord = z.infer<typeof JobSchema>;

export interface JobStore {
  read(): Promise<JobRecord[]>;
  write(records: JobRecord[]): Promise<void>;
}

export class MemoryJobStore implements JobStore {
  constructor(private records: JobRecord[] = []) {}
  async read() { return structuredClone(this.records); }
  async write(records: JobRecord[]) { this.records = structuredClone(records); }
}

export class FileJobStore implements JobStore {
  constructor(private path: string) {}
  async read(): Promise<JobRecord[]> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      return z.object({ version: z.literal(1), jobs: z.array(JobSchema).max(200) }).parse(raw).jobs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new ApiError(503, '生成任务缓存无法读取，请先备份并检查文件；不会覆盖原始数据');
    }
  }
  async write(records: JobRecord[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, jobs: records }), { flag: 'wx', mode: 0o600 });
    await rename(temporary, this.path);
  }
}

type Runner = (save: unknown, id: string, phase: (value: string) => void, apiKey?: string) => Promise<GeneratedEpisode>;

export class JobManager {
  private records = new Map<string, JobRecord>();
  private mutations: Promise<unknown> = Promise.resolve();
  private dailyLimit: number;

  constructor(private store: JobStore, private runner: Runner, options: { dailyLimit?: number } = {}) {
    this.dailyLimit = options.dailyLimit ?? 10;
  }

  async initialize() {
    const records = await this.store.read();
    let interrupted = false;
    for (const record of records) {
      if (record.status === 'queued' || record.status === 'running') {
        record.status = 'failed';
        record.phase = '已中断';
        record.error = '服务端在生成期间中断，未自动重新调用模型；可手动重新生成（可能产生费用）';
        interrupted = true;
      }
      this.records.set(record.id, record);
    }
    if (interrupted) await this.store.write([...this.records.values()]);
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation);
    this.mutations = result.catch(() => {});
    return result;
  }

  private async replace(record: JobRecord) {
    const next = new Map(this.records);
    next.set(record.id, record);
    await this.store.write([...next.values()]);
    this.records = next;
  }

  get(id: string): JobRecord | undefined {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  quota() {
    const today = new Date().toISOString().slice(0, 10);
    const used = [...this.records.values()].filter((job) => job.createdAt.startsWith(today)).length;
    return { dailyLimit: this.dailyLimit, used, remaining: Math.max(0, this.dailyLimit - used) };
  }

  submit(input: { requestId: string; save: unknown }, options: { apiKey?: string; allowNew?: boolean } = {}): Promise<JobRecord> {
    return this.mutate(async () => {
      const payloadHash = createHash('sha256').update(stableStringify(input.save)).digest('hex');
      const saved = input.save as { session?: { catalog?: unknown; events?: unknown }; generated?: unknown } | null;
      const story = saved?.session?.catalog && saved.session.events
        ? { catalog: saved.session.catalog, events: saved.session.events, generated: saved.generated } : input.save;
      const storyHash = createHash('sha256').update(stableStringify(story)).digest('hex');
      const existing = this.records.get(input.requestId);
      if (existing) {
        if (existing.payloadHash !== payloadHash) throw new ApiError(409, '任务 ID 已绑定到不同进度');
        return structuredClone(existing);
      }
      const duplicate = [...this.records.values()].find((job) =>
        (job.payloadHash === payloadHash || job.storyHash === storyHash) && job.status !== 'failed');
      if (duplicate) return structuredClone(duplicate);
      if (options.allowNew === false) throw new ApiError(401, '请在网页输入本次使用的 API Key，或配置服务端密钥；已有任务仍可恢复');
      if ([...this.records.values()].some((job) => job.status === 'queued' || job.status === 'running')) {
        throw new ApiError(429, '已有生成任务进行中，请等待完成后重试');
      }
      if (!this.quota().remaining) throw new ApiError(429, '今日生成额度已用完（按 UTC 日期重置），已有内容仍可播放');
      if (this.records.size >= 200) throw new ApiError(429, '本机任务缓存已达到上限，请先备份并整理，不会自动删除');
      const record: JobRecord = {
        id: input.requestId, payloadHash, storyHash, status: 'queued', phase: '已排队', createdAt: new Date().toISOString(),
      };
      await this.replace(record);
      void this.run(record.id, input.save, options.apiKey);
      return structuredClone(record);
    });
  }

  private async run(id: string, save: unknown, apiKey?: string) {
    try {
      await this.mutate(() => this.replace({ ...this.records.get(id)!, status: 'running', phase: '正在构思下一集' }));
      const result = await this.runner(save, id, (phase) => {
        void this.mutate(() => this.replace({ ...this.records.get(id)!, phase })).catch(() => {});
      }, apiKey);
      if (apiKey && JSON.stringify(result).includes(JSON.stringify(apiKey).slice(1, -1))) {
        throw new ApiError(502, '生成结果包含不应保存的凭据，已拒绝保存；已有进度未改变');
      }
      await this.mutate(() => this.replace({ ...this.records.get(id)!, status: 'succeeded', phase: '已完成', result }));
    } catch (error) {
      const chain: { statusCode?: number; name?: string; cause?: unknown }[] = [];
      let cause = error;
      while (cause && typeof cause === 'object' && chain.length < 4) {
        chain.push(cause);
        cause = (cause as { cause?: unknown }).cause;
      }
      const status = chain.find((entry) => entry.statusCode)?.statusCode;
      const timeout = chain.some((entry) => entry.name === 'AbortError' || entry.name === 'TimeoutError');
      const network = chain.some((entry) => entry.name === 'TypeError' || entry.name === 'FetchError');
      const failure: GenerationFailure = error instanceof ApiError && error.failure ? error.failure
        : { category: status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate-limit'
          : timeout ? 'timeout' : network ? 'network' : status ? 'provider' : 'unknown', codes: [] };
      const message = error instanceof ApiError && !(apiKey && error.message.includes(apiKey)) ? error.message
        : status === 401 || status === 403 ? '模型认证失败，请检查本次输入的 API Key 或服务端密钥与模型权限'
        : status === 429 ? '模型供应商限流或额度不足，请检查账户余额与限额，稍后手动重试'
        : timeout ? '模型响应超时，未自动重新付费调用。已有进度未改变，可稍后手动重试'
        : network ? '连接模型供应商失败，请检查本机网络或代理；已有进度未改变'
        : status ? `模型供应商返回 HTTP ${status}，已有进度未改变，请稍后手动重试`
        : '生成未完成或内容未通过校验；已有进度未改变。可手动重新生成（可能产生费用）';
      const failed: JobRecord = { ...this.records.get(id)!, status: 'failed', phase: '未完成', error: message, failure };
      try {
        await this.mutate(() => this.replace(failed));
      } catch {
        this.records.set(id, { ...failed, error: '服务端缓存写入失败，请检查磁盘；不会自动重新调用模型' });
      }
    } finally {
      apiKey = undefined;
    }
  }
}
