import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { createContent } from '@endless/content';
import { FileJobStore, JobManager } from './jobs.js';
import { createApiServer, defaultOrigins } from './server.js';
import { createProviderRunner } from './provider.js';
import { ExecutionGate } from './execution-gate.js';
import { EditionStore } from './edition/store.js';
import { EditionJobManager } from './edition/jobs.js';
import { createEditionCompileRunner } from './edition/runner.js';
import { createEditionRouter } from './edition/routes.js';

export async function startApplication(options: {
  modelsPath: string;
  lexiconPath: string;
  dataDirectory: string;
  port: number;
  origins?: readonly string[];
  handlePage?: Parameters<typeof createApiServer>[0]['handlePage'];
}) {
  const models = z.object({
    provider: z.object({
      name: z.string().min(1), base_url: z.url().startsWith('https://'),
      api_key_env: z.string().min(1), reasoning_effort: z.string().optional(),
      timeout_ms: z.number().int().positive().max(300_000).optional(),
    }),
    models: z.object({ fast: z.string().min(1), premium: z.string().min(1) }),
  });
  const config = models.parse(parseYaml(await readFile(options.modelsPath, 'utf8')));
  const content = createContent(await readFile(options.lexiconPath, 'utf8'));
  const apiKey = process.env[config.provider.api_key_env]?.trim() ?? '';
  // ENDLESS 与 Edition 共用同一个执行槽：两个模式不会同时跑外部任务
  const gate = new ExecutionGate();
  const jobs = new JobManager(
    new FileJobStore(join(options.dataDirectory, 'jobs.json')),
    createProviderRunner(content, config, apiKey),
    gate,
  );
  // Edition 的权威存储是本机 SQLite；与 jobs.json 独立，不迁移也不清理旧缓存
  const editionStore = new EditionStore(join(options.dataDirectory, 'edition.sqlite'));
  const editionJobs = new EditionJobManager(editionStore, createEditionCompileRunner(editionStore), gate);
  const origins = options.origins ?? defaultOrigins;
  const editionRouter = createEditionRouter({
    store: editionStore,
    jobs: editionJobs,
    origins: [...origins],
    // 未配置搜索服务时界面必须显示「不可用」，不能假装已经搜索
    searchAvailable: false,
  });
  const server = createApiServer({
    jobs, content, token: randomBytes(32).toString('hex'), configured: !!apiKey, model: config.models.fast,
    origins, handlePage: options.handlePage,
    edition: { handle: editionRouter },
  });
  try {
    const editionRecovery = editionJobs.initialize();
    await jobs.initialize();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, '127.0.0.1', resolve);
    });
    return {
      server, editionRecovery, configured: !!apiKey,
      close: async () => {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
        editionStore.close();
      },
    };
  } catch (error) {
    server.close();
    editionStore.close();
    throw error;
  }
}
