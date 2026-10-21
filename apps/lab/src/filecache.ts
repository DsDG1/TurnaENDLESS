/** 文件缓存（第 11 节 runs/<id>/cache/）：按请求哈希存原始响应，回放读缓存。 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LlmCache } from '@endless/director';

export class FileLlmCache implements LlmCache {
  constructor(private dir: string, private readonly readOnly = false) {}
  private path(hash: string): string {
    return join(this.dir, `${hash}.txt`);
  }
  async get(hash: string): Promise<string | null> {
    try {
      return await readFile(this.path(hash), 'utf8');
    } catch {
      return null;
    }
  }
  async put(hash: string, value: string): Promise<void> {
    if (this.readOnly) return;
    await writeFile(this.path(hash), value, 'utf8');
  }
}
