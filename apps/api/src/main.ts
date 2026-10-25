import { fileURLToPath } from 'node:url';
import { startApplication } from './application.js';

try {
  const { configured, editionRecovery } = await startApplication({
    modelsPath: fileURLToPath(new URL('../../lab/config/models.yaml', import.meta.url)),
    lexiconPath: fileURLToPath(new URL('../../lab/data/lexicon/a1_a2.yaml', import.meta.url)),
    dataDirectory: fileURLToPath(new URL('../data.local/', import.meta.url)),
    port: 4174,
  });
  console.log(`ENDLESS AI API: http://127.0.0.1:4174 (${configured ? '服务端密钥已配置，也可使用网页临时 Key' : '支持网页临时 Key，离线模式可用'})`);
  console.log(`Edition: 恢复中断任务 ${editionRecovery.interrupted} 个、未保存调用 ${editionRecovery.unknown} 个（不自动重放）`);
} catch {
  console.error('ENDLESS AI 服务启动失败，请检查 4174 端口、文件权限及 data.local/jobs.json；不会覆盖原始缓存。');
  process.exitCode = 1;
}
