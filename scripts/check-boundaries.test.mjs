import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { checkGraph, references } from './check-boundaries.mjs';

test('extracts dependency syntax without treating comments or ordinary strings as imports', () => {
  assert.deepEqual(references(`
    // import { x } from 'comment';
    const text = "import('text')";
    import type { A } from 'types';
    export * from 'barrel';
    const module = import('dynamic');
    const cjs = require('commonjs');
    type T = import('inline').T;
    import legacy = require('legacy');
  `), ['types', 'barrel', 'dynamic', 'commonjs', 'inline', 'legacy']);
  assert.throws(() => references('import(target)'), /Non-literal/);
  assert.deepEqual(references(`import type { A } from 'type-only'; import { type B } from 'mixed-types'; export type { C } from 'export-types'; type D = import('inline').D; import 'runtime';`, 'source.ts', true), ['mixed-types', 'runtime']);
});

test('follows transitive barrels, subpaths, relative deep imports and cycles; refuses missing exports', () => {
  const base = mkdtempSync(join(tmpdir(), 'endless-boundaries-'));
  const write = (file, text) => { mkdirSync(dirname(join(base, file)), { recursive: true }); writeFileSync(join(base, file), text); };
  try {
    write('packages/core/package.json', JSON.stringify({ name: '@endless/core', exports: { '.': './index.ts', './cloud': './cloud.ts' } }));
    write('packages/core/index.ts', "export * from './shared.js';");
    write('packages/core/shared.ts', "export * from './index.js';");
    write('packages/core/cloud.ts', 'export const cloud = true;');
    write('entry.ts', "import '@endless/core';");
    const forbidden = file => file.endsWith('/cloud.ts');
    assert.deepEqual(checkGraph(base, ['entry.ts'], forbidden), []);
    write('packages/core/shared.ts', "export * from './cloud.js';");
    assert.match(checkGraph(base, ['entry.ts'], forbidden)[0], /entry.ts -> packages\/core\/index.ts -> packages\/core\/shared.ts -> packages\/core\/cloud.ts/);
    write('entry.ts', "import('@endless/core/cloud');");
    assert.equal(checkGraph(base, ['entry.ts'], forbidden).length, 1);
    write('entry.ts', "import './packages/core/cloud.js';");
    assert.equal(checkGraph(base, ['entry.ts'], forbidden).length, 1);
    write('entry.ts', "import '@endless/core/private';");
    assert.throws(() => checkGraph(base, ['entry.ts'], forbidden), /Unexported/);
    write('packages/content/src/index.ts', "import 'pg';");
    assert.match(checkGraph(base, ['packages/content/src/index.ts'], () => false)[0], / -> pg$/);
    write('packages/cloud-contracts/src/index.ts', "import 'node:fs';");
    assert.match(checkGraph(base, ['packages/cloud-contracts/src/index.ts'], () => false)[0], / -> node:fs$/);
  } finally {
    if (dirname(resolve(base)) !== resolve(tmpdir())) throw new Error('Refusing cleanup outside the test temp directory');
    rmSync(base, { recursive: true, force: true });
  }
});
