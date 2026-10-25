import { describe, expect, it } from 'vitest';
import { loadCloudConfig, loadCloudWorkerConfig } from '../../src/cloud/config.js';
import { openMail, sealMail } from '../../src/cloud/mail.js';

const apiEnv = {
  ENDLESS_CLOUD_ENV: 'test',
  ENDLESS_CLOUD_AUTH_DSN: 'postgres://auth:synthetic@127.0.0.1/test',
  ENDLESS_CLOUD_APP_DSN: 'postgres://app:synthetic@127.0.0.1/test',
  ENDLESS_CLOUD_SESSION_PEPPER: 'synthetic-pepper-at-least-32-bytes!',
  ENDLESS_CLOUD_MAIL_KEY: 'ab'.repeat(32),
};
const smtpEnv = {
  ENDLESS_CLOUD_ENV: 'test',
  ENDLESS_CLOUD_AUTH_DSN: apiEnv.ENDLESS_CLOUD_AUTH_DSN,
  ENDLESS_CLOUD_MAIL_KEY: apiEnv.ENDLESS_CLOUD_MAIL_KEY,
  ENDLESS_CLOUD_SMTP_ENV: 'test',
  ENDLESS_CLOUD_SMTP_HOST: 'localhost',
  ENDLESS_CLOUD_SMTP_FROM: 'endless@example.test',
  ENDLESS_CLOUD_SMTP_USER: 'synthetic',
  ENDLESS_CLOUD_SMTP_PASSWORD: 'synthetic-smtp-password',
};

describe('C1 配置与秘密边界', () => {
  it('不把本机 provider Key 当云端配置，缺失秘密报错不泄露值', () => {
    expect(() => loadCloudConfig({ ENDLESS_API_KEY: 'synthetic-provider-secret' })).toThrow('配置');
    expect(() => loadCloudConfig({ ...apiEnv, ENDLESS_CLOUD_MAIL_KEY: 'synthetic-invalid-secret' })).toThrow('mailKey');
    try {
      loadCloudConfig({ ...apiEnv, ENDLESS_CLOUD_MAIL_KEY: 'synthetic-invalid-secret' });
    } catch (error) {
      expect(String(error)).not.toContain('synthetic-invalid-secret');
    }
  });

  it('预发布和生产要求显式 HTTPS 来源且禁止验证码日志', () => {
    for (const environment of ['staging', 'production']) {
      expect(() => loadCloudConfig({ ...apiEnv, ENDLESS_CLOUD_ENV: environment })).toThrow();
      const configured = {
        ...apiEnv, ENDLESS_CLOUD_ENV: environment,
        ENDLESS_CLOUD_ORIGINS: 'https://endless.example.test', ENDLESS_CLOUD_HOSTS: 'endless.example.test',
      };
      expect(loadCloudConfig(configured).host).toBe('127.0.0.1');
      expect(() => loadCloudConfig({ ...configured, ENDLESS_CLOUD_ORIGINS: 'http://endless.example.test' })).toThrow('https');
      expect(() => loadCloudConfig({ ...configured, ENDLESS_CLOUD_MAIL_ECHO: '1' })).toThrow('验证码日志');
      expect(() => loadCloudConfig({ ...configured, ENDLESS_CLOUD_ORIGINS: 'https://endless.example.test/path' })).toThrow('无路径');
    }
  });

  it('SMTP 配置只允许 TLS 或强制 STARTTLS，并显式匹配环境', () => {
    expect(loadCloudWorkerConfig(smtpEnv).smtpMode).toBe('tls');
    expect(loadCloudWorkerConfig({ ...smtpEnv, ENDLESS_CLOUD_SMTP_MODE: 'starttls' }).smtpMode).toBe('starttls');
    expect(() => loadCloudWorkerConfig({ ...smtpEnv, ENDLESS_CLOUD_SMTP_MODE: 'plain' })).toThrow();
    expect(() => loadCloudWorkerConfig({ ...smtpEnv, ENDLESS_CLOUD_SMTP_ENV: 'production' })).toThrow('环境');
    expect(() => loadCloudWorkerConfig({ ...smtpEnv, ENDLESS_CLOUD_SMTP_PASSWORD: '' })).toThrow('smtpPassword');
  });

  it('邮件密文绑定行 ID、拒绝篡改和错误密钥，不包含验证码明文', () => {
    const key = Buffer.from(apiEnv.ENDLESS_CLOUD_MAIL_KEY, 'hex');
    const message = { recipient: 'synthetic@example.test', subject: 'ENDLESS', text: 'code: 654321' };
    const payload = sealMail(key, 'mail-one', message);
    expect(payload.includes(Buffer.from('654321'))).toBe(false);
    expect(payload.includes(Buffer.from(message.recipient))).toBe(false);
    expect(openMail(key, 'mail-one', payload)).toEqual(message);
    expect(() => openMail(key, 'mail-two', payload)).toThrow();
    expect(() => openMail(Buffer.alloc(32, 3), 'mail-one', payload)).toThrow();
    const tampered = Buffer.from(payload);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    expect(() => openMail(key, 'mail-one', tampered)).toThrow();
  });
});
