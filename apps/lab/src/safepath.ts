/** CLI 路径守卫：用户传入的路径解析后必须位于允许的根目录内，拒绝越界访问。 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export function safePath(input: string, allowedRoots: string[], what: string): string {
  const abs = resolve(input);
  const ok = allowedRoots.some((root) => {
    const r = resolve(root);
    return abs === r || abs.startsWith(r + sep);
  });
  if (!ok) {
    throw new Error(`非法路径：${what} "${input}" 不在允许目录（${allowedRoots.join(' / ')}）内`);
  }
  return abs;
}

/** 目录 + 固定子路径的组合也走同一校验（子路径来自不受信输入时尤其必要）。 */
export function safeChild(dir: string, child: string, allowedRoots: string[], what: string): string {
  return safePath(resolve(dir, child), allowedRoots, what);
}

/** 受信读取：校验后读取文件内容。 */
export async function readValidated(input: string, allowedRoots: string[], what: string): Promise<string> {
  return readFile(safePath(input, allowedRoots, what), 'utf8');
}

/** 受信写入：校验后写入文件。 */
export async function writeValidated(output: string, allowedRoots: string[], what: string, content: string): Promise<void> {
  await writeFile(safePath(output, allowedRoots, what), content, 'utf8');
}
