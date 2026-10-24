import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { GenerationRequestSchema, type Content } from '@endless/content';
import { ApiError, type JobManager } from './jobs.js';
import { preparedFeatures } from './extensions/index.js';

const origins = new Set(['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:4173', 'http://localhost:4173']);
const MAX_BODY_BYTES = 3 * 1024 * 1024;

export function createApiServer(options: {
  jobs: JobManager; content: Content; token: string; configured: boolean; model: string;
  ready?: () => boolean;
  /** Edition 路由：返回 false 表示不是它的路径，交回原有分发。 */
  edition?: { handle: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean> };
}) {
  const { jobs, content, token, configured, model } = options;

  function send(response: ServerResponse, status: number, body: unknown) {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    response.end(JSON.stringify(body));
  }

  function authorize(request: IncomingMessage) {
    const supplied = Buffer.from(request.headers['x-endless-token']?.toString() ?? '');
    const expected = Buffer.from(token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new ApiError(403, '本机服务会话已更新，请刷新状态后重试');
    }
  }

  async function body(request: IncomingMessage) {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) throw new ApiError(413, '存档超过本机生成接口大小上限，请先导出备份');
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new ApiError(400, '请求不是有效的 JSON');
    }
  }

  const server = createServer((request, response) => {
    void (async () => {
      if (options.ready && !options.ready()) throw new ApiError(503, '本机服务正在恢复任务缓存，请稍后重试');
      const address = server.address();
      const port = address && typeof address !== 'string' ? address.port : 4174;
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host ?? '') ||
        (request.headers.origin && !origins.has(request.headers.origin)) ||
        request.headers['sec-fetch-site'] === 'cross-site') {
        throw new ApiError(403, '此接口仅供本机 ENDLESS 页面访问');
      }
      if (request.method === 'GET' && request.url === '/api/status') {
        send(response, 200, { configured, acceptsUserKey: true, model, token, features: preparedFeatures });
        return;
      }
      authorize(request);
      if (options.edition) {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (await options.edition.handle(request, response, url)) return;
      }
      if (request.method === 'GET' && /^\/api\/generations\/[a-f0-9-]{36}$/.test(request.url ?? '')) {
        const record = jobs.get(request.url!.split('/').at(-1)!);
        if (!record) throw new ApiError(404, '找不到生成任务；请使用原任务 ID 恢复，不要盲目重复生成');
        const { payloadHash: _, storyHash: __, ...publicJob } = record;
        send(response, 200, publicJob);
        return;
      }
      if (request.method === 'POST' && request.url === '/api/generations') {
        if (!request.headers.origin || !origins.has(request.headers.origin)) throw new ApiError(403, '缺少合法的页面来源');
        if (!request.headers['content-type']?.startsWith('application/json')) throw new ApiError(415, '仅接受 application/json');
        const suppliedKey = request.headers['x-endless-provider-key'];
        if (suppliedKey !== undefined && (typeof suppliedKey !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(suppliedKey))) {
          throw new ApiError(400, 'API Key 格式不正确，请重新输入；不会保存或回显密钥');
        }
        const parsed = GenerationRequestSchema.safeParse(await body(request));
        if (!parsed.success) throw new ApiError(400, '生成请求或存档格式无法识别，已有数据未修改');
        try {
          const restored = content.restore(parsed.data.save);
          // 应用只接受 v4 创作草稿契约：不可信输入不能靠 legacy 文档把任意正文塞进生成上下文
          if (parsed.data.save.generated.some((document) => document.learningVersion !== 4)) {
            throw new ApiError(422, '当前应用只接受 v4 创作草稿生成的内容；旧版存档不会被自动升级，请先导出备份');
          }
          content.planCreative(restored.session, restored.library);
        } catch (error) {
          if (error instanceof ApiError) throw error;
          throw new ApiError(422, '存档内容不合法、版本不匹配或仍有未看完的故事');
        }
        const job = await jobs.submit(parsed.data, { apiKey: suppliedKey, allowNew: configured || !!suppliedKey });
        const { payloadHash: _, storyHash: __, ...publicJob } = job;
        send(response, job.status === 'succeeded' || job.status === 'failed' ? 200 : 202, publicJob);
        return;
      }
      throw new ApiError(404, '接口不存在');
    })().catch((error: unknown) => {
      if (!response.headersSent) send(response, error instanceof ApiError ? error.status : 503, {
        error: error instanceof ApiError ? error.message : '本机服务暂不可用，请检查服务端存储；不会自动重试模型调用',
      });
      else response.end();
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}
