import { describe, expect, it } from 'vitest';
import { loadCloudObjectConfig } from '../../src/cloud/objects/config.js';

const env = {
  ENDLESS_CLOUD_OBJECTS_ENABLED: '1',
  ENDLESS_CLOUD_S3_ENV: 'test',
  ENDLESS_CLOUD_S3_ENDPOINT: 'http://127.0.0.1:9000',
  ENDLESS_CLOUD_S3_BUCKET: 'endless-test',
  ENDLESS_CLOUD_S3_REGION: 'test-1',
  ENDLESS_CLOUD_S3_ACCESS_KEY_ID: 'synthetic-access',
  ENDLESS_CLOUD_S3_SECRET_ACCESS_KEY: 'synthetic-secret-only',
  ENDLESS_CLOUD_OBJECT_QUOTA_BYTES: '4194304',
};

describe('C2 对象配置隔离', () => {
  it('默认不启用，不读取 AWS 默认凭据或本机配置', () => {
    expect(loadCloudObjectConfig({}, 'test')).toBeUndefined();
    expect(loadCloudObjectConfig({ AWS_ACCESS_KEY_ID: 'synthetic' }, 'test')).toBeUndefined();
    expect(() => loadCloudObjectConfig({ ENDLESS_CLOUD_OBJECTS_ENABLED: 'true' }, 'test')).toThrow();
  });

  it('显式启用需要全部配置、环境匹配和有限容量', () => {
    expect(loadCloudObjectConfig(env, 'test')?.quotaBytes).toBe(4_194_304);
    expect(() => loadCloudObjectConfig({ ...env, ENDLESS_CLOUD_S3_ENV: 'production' }, 'test')).toThrow('环境');
    for (const quota of ['0', '-1', 'Infinity', '1.5', '9007199254740992', '']) {
      expect(() => loadCloudObjectConfig({ ...env, ENDLESS_CLOUD_OBJECT_QUOTA_BYTES: quota }, 'test')).toThrow();
    }
  });

  it('HTTPS 强制，不接受端点 URL 中的凭据、路径和非回环 HTTP', () => {
    for (const endpoint of [
      'http://storage.example.test', 'https://synthetic:secret@storage.example.test',
      'https://storage.example.test/bucket', 'https://storage.example.test/?token=synthetic',
      'https://storage.example.test/#secret', 'ftp://storage.example.test',
    ]) expect(() => loadCloudObjectConfig({ ...env, ENDLESS_CLOUD_S3_ENDPOINT: endpoint }, 'test')).toThrow();
    const production = { ...env, ENDLESS_CLOUD_S3_ENV: 'production' };
    expect(() => loadCloudObjectConfig(production, 'production')).toThrow('HTTPS');
    expect(loadCloudObjectConfig({ ...production, ENDLESS_CLOUD_S3_ENDPOINT: 'https://storage.example.test' }, 'production')?.bucket).toBe('endless-test');
  });

  it('错误只包含字段名，不包含秘密值', () => {
    try {
      loadCloudObjectConfig({ ...env, ENDLESS_CLOUD_S3_SECRET_ACCESS_KEY: '', ENDLESS_CLOUD_S3_BUCKET: 'INVALID' }, 'test');
      throw new Error('expected configuration failure');
    } catch (error) {
      expect(String(error)).toContain('bucket');
      expect(String(error)).not.toContain(env.ENDLESS_CLOUD_S3_ACCESS_KEY_ID);
      expect(String(error)).not.toContain(env.ENDLESS_CLOUD_S3_SECRET_ACCESS_KEY);
    }
  });
});
