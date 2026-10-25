import { expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../src/cloud/', import.meta.url));

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory()
    ? sources(join(directory, entry.name))
    : Promise.resolve(entry.name.endsWith('.ts') ? [join(directory, entry.name)] : [])))).flat();
}

it('云端源文件不得导入本机 API 或实验应用，只使用明确依赖', async () => {
  const allowed = new Set(['pg', 'zod', 'nodemailer', '@endless/cloud-contracts', '@endless/esl']);
  for (const file of await sources(root)) {
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const name = statement.moduleSpecifier.text;
      if (name.startsWith('.')) {
        expect(relative(root, resolve(dirname(file), name)).startsWith('..'), `${file}: ${name}`).toBe(false);
      } else {
        expect(name.startsWith('node:') || allowed.has(name), `${file}: ${name}`).toBe(true);
      }
    }
    const forbidden = new Set(['jobs.json', 'edition.sqlite', 'ENDLESS_API_KEY', 'ENDLESS_PROVIDER_KEY', 'X-Endless-Token']);
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node)) expect(forbidden.has(node.text), `${file}: ${node.text}`).toBe(false);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
});
