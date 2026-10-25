import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';
import metadata from './package.json' with { type: 'json' };

if (process.platform !== 'win32') throw new Error('Build the Windows test package on Windows.');
const base = fileURLToPath(new URL('../../out/desktop/', import.meta.url));
const output = existsSync(join(base, 'ENDLESS-Test-win32-x64')) ? join(base, `build-${Date.now()}`) : base;
const checksums = JSON.parse(await readFile(new URL('./node_modules/electron/checksums.json', import.meta.url), 'utf8'));
const paths = await packager({
  dir: fileURLToPath(new URL('./dist/', import.meta.url)),
  out: output,
  name: 'ENDLESS-Test', platform: 'win32', arch: 'x64',
  electronVersion: metadata.devDependencies.electron, asar: false, prune: false,
  overwrite: false,
  executableName: 'ENDLESS-Test',
  appCopyright: 'ENDLESS',
  download: { checksums },
});
for (const path of paths) console.log(`Windows test app: ${path}`);
if (paths.length !== 1) throw new Error('Expected exactly one Windows application.');
await writeFile(join(base, 'latest.json'), JSON.stringify({ executable: join(paths[0], 'ENDLESS-Test.exe') }, null, 2));
