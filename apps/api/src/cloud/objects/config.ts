import { z } from 'zod';
import { CloudEnvironmentSchema, type CloudDeployment } from '../deployment.js';
import type { S3ObjectConfig } from './storage.js';

const ObjectConfigSchema = z.object({
  environment: CloudEnvironmentSchema,
  endpoint: z.url(),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  region: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  accessKeyId: z.string().min(1).max(256),
  secretAccessKey: z.string().min(1).max(1024),
  quotaBytes: z.coerce.number().int().min(1).max(1_099_511_627_776),
});

export function loadCloudObjectConfig(env: NodeJS.ProcessEnv, environment: CloudDeployment['environment']): (S3ObjectConfig & { quotaBytes: number }) | undefined {
  const enabled = env.ENDLESS_CLOUD_OBJECTS_ENABLED;
  if (enabled === undefined || enabled === '0') return undefined;
  if (enabled !== '1') throw new Error('ENDLESS_CLOUD_OBJECTS_ENABLED 必须为 0 或 1');
  const parsed = ObjectConfigSchema.safeParse({
    environment: env.ENDLESS_CLOUD_S3_ENV,
    endpoint: env.ENDLESS_CLOUD_S3_ENDPOINT,
    bucket: env.ENDLESS_CLOUD_S3_BUCKET,
    region: env.ENDLESS_CLOUD_S3_REGION,
    accessKeyId: env.ENDLESS_CLOUD_S3_ACCESS_KEY_ID,
    secretAccessKey: env.ENDLESS_CLOUD_S3_SECRET_ACCESS_KEY,
    quotaBytes: env.ENDLESS_CLOUD_OBJECT_QUOTA_BYTES,
  });
  if (!parsed.success) throw new Error(`云对象存储配置无效：${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
  const config = parsed.data;
  if (config.environment !== environment) throw new Error('对象存储环境标签不匹配');
  const url = new URL(config.endpoint);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('对象存储入口必须是无凭据和路径的完整来源');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && ['development', 'test'].includes(environment))) {
    throw new Error('对象存储必须使用 HTTPS；仅开发/测试回环协议服务允许 HTTP');
  }
  return config;
}
