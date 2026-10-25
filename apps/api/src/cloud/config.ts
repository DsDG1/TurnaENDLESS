import { z } from 'zod';

/**
 * 云服务配置：全部由环境显式注入，不读本机 .env 兜底语义之外的秘密。
 * 与本机 main.ts 完全分离；云入口不读取 jobs.json / edition.sqlite / 页面 Key。
 */
const ConfigSchema = z.object({
  env: z.enum(['development', 'test', 'production']).default('development'),
  port: z.coerce.number().int().min(1).max(65535).default(4178),
  host: z.string().min(1).default('127.0.0.1'),
  /** 身份域 DSN（endless_auth 角色）。 */
  authDsn: z.string().min(1),
  /** 业务域 DSN（endless_app 角色，RLS 租户隔离）。 */
  appDsn: z.string().min(1),
  /** 会话/挑战 HMAC pepper：至少 32 字节的随机秘密，来自 secret manager 注入。 */
  sessionPepper: z.string().min(32),
  /** 允许携带 Cookie 发起状态变更的页面 Origin 白名单。 */
  origins: z.array(z.url()).min(1),
  /** 允许的 Host 头；不命中即拒绝，防 DNS rebinding。 */
  hosts: z.array(z.string().min(1)).min(1),
  /** 把待发邮件同时打到 stdout（仅开发；正文含验证码，绝不进入 HTTP 响应）。 */
  mailEcho: z.boolean().default(false),
});

export type CloudConfig = z.infer<typeof ConfigSchema>;

function splitList(value: string | undefined): string[] | undefined {
  return value?.split(',').map((entry) => entry.trim()).filter(Boolean);
}

export function loadCloudConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
  const parsed = ConfigSchema.safeParse({
    env: env.ENDLESS_CLOUD_ENV,
    port: env.ENDLESS_CLOUD_PORT,
    host: env.ENDLESS_CLOUD_HOST,
    authDsn: env.ENDLESS_CLOUD_AUTH_DSN,
    appDsn: env.ENDLESS_CLOUD_APP_DSN,
    sessionPepper: env.ENDLESS_CLOUD_SESSION_PEPPER,
    origins: splitList(env.ENDLESS_CLOUD_ORIGINS) ?? (env.ENDLESS_CLOUD_ENV === 'production' ? undefined : ['http://127.0.0.1:5173', 'http://localhost:5173']),
    hosts: splitList(env.ENDLESS_CLOUD_HOSTS) ?? (env.ENDLESS_CLOUD_ENV === 'production' ? undefined : ['127.0.0.1', 'localhost']),
    mailEcho: env.ENDLESS_CLOUD_MAIL_ECHO === '1',
  });
  if (!parsed.success) {
    throw new Error(`云服务配置无效或缺失（ENDLESS_CLOUD_*）：${parsed.error.issues.map((issue) => issue.path.join('.') || issue.message).join(', ')}`);
  }
  const config = parsed.data;
  if (config.env === 'production') {
    if (config.host === '127.0.0.1' || config.host === 'localhost') {
      throw new Error('生产环境必须显式配置 ENDLESS_CLOUD_HOST / 网关入口，不能回环监听');
    }
    if (config.origins.some((origin) => !origin.startsWith('https://'))) {
      throw new Error('生产环境 Origin 白名单必须是 https');
    }
  }
  return config;
}
