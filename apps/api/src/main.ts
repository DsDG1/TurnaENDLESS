import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { createContent } from '@endless/content';
import { FileJobStore, JobManager } from './jobs.js';
import { createApiServer } from './server.js';
import { createProviderRunner } from './provider.js';

const models = z.object({
  provider: z.object({
    name: z.string().min(1), base_url: z.url().startsWith('https://'),
    api_key_env: z.string().min(1), reasoning_effort: z.string().optional(),
    timeout_ms: z.number().int().positive().max(300_000).optional(),
  }),
  models: z.object({ fast: z.string().min(1), premium: z.string().min(1) }),
}).parse(parseYaml(await readFile(new URL('../../lab/config/models.yaml', import.meta.url), 'utf8')));

const content = createContent(await readFile(new URL('../../lab/data/lexicon/a1_a2.yaml', import.meta.url), 'utf8'));
const apiKey = process.env[models.provider.api_key_env]?.trim() ?? '';
const jobs = new JobManager(
  new FileJobStore(fileURLToPath(new URL('../data.local/jobs.json', import.meta.url))),
  createProviderRunner(content, models, apiKey),
);
let ready = false;
const server = createApiServer({
  jobs, content, token: randomBytes(32).toString('hex'), configured: !!apiKey, model: models.models.fast,
  ready: () => ready,
});
try {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(4174, '127.0.0.1', resolve);
  });
  await jobs.initialize();
  ready = true;
  console.log(`ENDLESS AI API: http://127.0.0.1:4174 (${apiKey ? '服务端密钥已配置，也可使用网页临时 Key' : '支持网页临时 Key，离线模式可用'})`);
} catch {
  server.close();
  console.error('ENDLESS AI 服务启动失败，请检查 4174 端口、文件权限及 data.local/jobs.json；不会覆盖原始缓存。');
  process.exitCode = 1;
}
