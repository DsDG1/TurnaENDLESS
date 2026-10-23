import { ApiStatusSchema, GenerationJobSchema, type GenerationRequest } from '@endless/content';

async function request(path: string, options: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try {
    const timeout = AbortSignal.timeout(15_000);
    response = await fetch(path, { ...options, cache: 'no-store', signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout });
  } catch {
    throw new Error('无法连接本机 AI 服务。请启动 pnpm dev 或 pnpm preview；已有内容仍可离线播放');
  }
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('AI 服务尚未就绪，请启动新版服务并刷新状态');
  }
  const raw: unknown = await response.json();
  if (!response.ok) {
    const message = raw && typeof raw === 'object' && 'error' in raw && typeof raw.error === 'string' ? raw.error : 'AI 请求未完成';
    throw new Error(message);
  }
  return raw;
}

export async function apiStatus() {
  return ApiStatusSchema.parse(await request('/api/status'));
}

export async function generateEpisode(
  input: GenerationRequest, onPhase: (phase: string) => void, signal: AbortSignal, apiKey = '', resume = false,
) {
  const status = await apiStatus();
  apiKey = apiKey.trim();
  if (apiKey && !/^[\x21-\x7e]{1,4096}$/.test(apiKey)) throw new Error('API Key 格式不正确，请重新输入；密钥不会保存或回显');
  if (apiKey && !status.acceptsUserKey) throw new Error('当前服务端尚不支持网页临时 Key，请更新并重启本机服务');
  if (!apiKey && !status.configured && !resume) throw new Error('请先在网页输入自己的 API Key；只保留在当前页面内存中');
  const headers = { 'Content-Type': 'application/json', 'X-Endless-Token': status.token };
  let job;
  try {
    job = GenerationJobSchema.parse(await request('/api/generations', {
      method: 'POST', headers: { ...headers, ...(apiKey ? { 'X-Endless-Provider-Key': apiKey } : {}) },
      body: JSON.stringify(input), signal,
    }));
  } finally {
    apiKey = '';
  }
  const deadline = Date.now() + 20 * 60_000;
  while (job.status === 'queued' || job.status === 'running') {
    signal.throwIfAborted();
    onPhase(job.phase);
    if (Date.now() >= deadline) throw new Error('等待超时，任务 ID 已保留。请恢复原任务，不要重复付费生成');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    signal.throwIfAborted();
    job = GenerationJobSchema.parse(await request(`/api/generations/${job.id}`, { headers, signal }));
  }
  if (job.status === 'failed') return { failed: true as const, message: job.error ?? '生成失败，已有进度未改变', failure: job.failure };
  if (!job.result) throw new Error('生成结果缺少内容，原任务 ID 已保留，请恢复原任务');
  return { failed: false as const, document: job.result };
}
