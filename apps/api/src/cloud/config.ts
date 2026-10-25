import { z } from 'zod';
import { CloudEnvironmentSchema } from './deployment.js';

/**
 * 云服务配置：全部由环境显式注入，不读本机 .env 兜底语义之外的秘密。
 * 与本机 main.ts 完全分离；云入口不读取 jobs.json / edition.sqlite / 页面 Key。
 */
const ConfigSchema = z.object({
  env: CloudEnvironmentSchema.default('development'),
  port: z.coerce.number().int().min(1).max(65535).default(4178),
  host: z.string().min(1).default('127.0.0.1'),
  /** 身份域 DSN（endless_auth 角色）。 */
  authDsn: z.string().min(1),
  /** 业务域 DSN（endless_app 角色，RLS 租户隔离）。 */
  appDsn: z.string().min(1),
  /** 会话/挑战 HMAC pepper：至少 32 字节的随机秘密，来自 secret manager 注入。 */
  sessionPepper: z.string().min(32),
  mailKey: z.string().regex(/^[0-9a-f]{64}$/i),
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
    mailKey: env.ENDLESS_CLOUD_MAIL_KEY,
    origins: splitList(env.ENDLESS_CLOUD_ORIGINS) ?? (env.ENDLESS_CLOUD_ENV === 'production' || env.ENDLESS_CLOUD_ENV === 'staging' ? undefined : ['http://127.0.0.1:5173', 'http://localhost:5173']),
    hosts: splitList(env.ENDLESS_CLOUD_HOSTS) ?? (env.ENDLESS_CLOUD_ENV === 'production' || env.ENDLESS_CLOUD_ENV === 'staging' ? undefined : ['127.0.0.1', 'localhost']),
    mailEcho: env.ENDLESS_CLOUD_MAIL_ECHO === '1',
  });
  if (!parsed.success) {
    throw new Error(`云服务配置无效或缺失（ENDLESS_CLOUD_*）：${parsed.error.issues.map((issue) => issue.path.join('.') || issue.message).join(', ')}`);
  }
  const config = parsed.data;
  if (config.env === 'production' || config.env === 'staging') {
    if (config.origins.some((origin) => !origin.startsWith('https://'))) {
      throw new Error('生产环境 Origin 白名单必须是 https');
    }
    if (config.mailEcho) throw new Error('预发布和生产环境禁止验证码日志');
  }
  if (config.origins.some((origin) => new URL(origin).origin !== origin)) {
    throw new Error('Origin 白名单必须是无路径的完整来源');
  }
  if (config.hosts.some((host) => !/^[a-z0-9.-]+$/i.test(host))) {
    throw new Error('Host 白名单必须只包含主机名，不含协议、端口或路径');
  }
  return config;
}

const WorkerConfigSchema = z.object({
  env: CloudEnvironmentSchema.default('development'),
  authDsn: z.string().min(1),
  mailKey: z.string().regex(/^[0-9a-f]{64}$/i),
  smtpEnvironment: CloudEnvironmentSchema,
  smtpHost: z.string().min(1).regex(/^[a-z0-9.-]+$/i),
  smtpPort: z.coerce.number().int().min(1).max(65535).default(465),
  smtpMode: z.enum(['tls', 'starttls']).default('tls'),
  smtpFrom: z.string().email(),
  smtpUser: z.string().min(1),
  smtpPassword: z.string().min(1),
  smtpCaFile: z.string().min(1).optional(),
});

export type CloudWorkerConfig = z.infer<typeof WorkerConfigSchema>;

export function loadCloudWorkerConfig(env: NodeJS.ProcessEnv = process.env): CloudWorkerConfig {
  const parsed = WorkerConfigSchema.safeParse({
    env: env.ENDLESS_CLOUD_ENV,
    authDsn: env.ENDLESS_CLOUD_AUTH_DSN,
    mailKey: env.ENDLESS_CLOUD_MAIL_KEY,
    smtpEnvironment: env.ENDLESS_CLOUD_SMTP_ENV,
    smtpHost: env.ENDLESS_CLOUD_SMTP_HOST,
    smtpPort: env.ENDLESS_CLOUD_SMTP_PORT,
    smtpMode: env.ENDLESS_CLOUD_SMTP_MODE,
    smtpFrom: env.ENDLESS_CLOUD_SMTP_FROM,
    smtpUser: env.ENDLESS_CLOUD_SMTP_USER,
    smtpPassword: env.ENDLESS_CLOUD_SMTP_PASSWORD,
    smtpCaFile: env.ENDLESS_CLOUD_SMTP_CA_FILE,
  });
  if (!parsed.success) {
    throw new Error(`云 Worker 配置无效或缺失：${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
  }
  if (parsed.data.smtpEnvironment !== parsed.data.env) throw new Error('SMTP 环境标签与云环境不匹配');
  return parsed.data;
}
