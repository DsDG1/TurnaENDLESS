import { describe, expect, it } from 'vitest';
import { assertPostgresCanStart } from './embedded-pg.js';

describe('嵌入式 PostgreSQL 启动前的环境护栏', () => {
  it('非 Windows 平台不受管理员令牌影响', () => {
    expect(() => assertPostgresCanStart({ platform: 'linux', probe: () => true })).not.toThrow();
  });

  it('Windows 非管理员会话照常启动', () => {
    expect(() => assertPostgresCanStart({ platform: 'win32', probe: () => false })).not.toThrow();
  });

  it('Windows 管理员会话立即失败，并给出非管理员终端的可执行提示', () => {
    let message = '';
    try {
      assertPostgresCanStart({ platform: 'win32', probe: () => true });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // 不挂到钩子超时，而是立刻说明原因与下一步命令
    expect(message).toContain('管理员权限');
    expect(message).toContain('pnpm -C apps/api test:cloud');
    expect(message).toContain('非 PG 用例不受影响');
  });
});
