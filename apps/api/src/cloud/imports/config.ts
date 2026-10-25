import { z } from 'zod';

export function loadCloudImportConfig(env: NodeJS.ProcessEnv, objectsEnabled: boolean) {
  const enabled = env.ENDLESS_CLOUD_IMPORTS_ENABLED;
  if (enabled === undefined || enabled === '0') return undefined;
  if (enabled !== '1') throw new Error('ENDLESS_CLOUD_IMPORTS_ENABLED 必须为 0 或 1');
  if (!objectsEnabled) throw new Error('存档导入要求显式启用对象存储');
  const path = z.string().min(1).safeParse(env.ENDLESS_CLOUD_LEXICON_FILE);
  if (!path.success) throw new Error('存档导入要求显式 ENDLESS_CLOUD_LEXICON_FILE');
  return { lexiconFile: path.data };
}
