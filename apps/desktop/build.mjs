import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { build } from 'esbuild';
import metadata from './package.json' with { type: 'json' };

const root = fileURLToPath(new URL('.', import.meta.url));
const dist = join(root, 'dist');
const webProfile = JSON.parse(await readFile(new URL('../web/dist/runtime-modules.json', import.meta.url), 'utf8'));
if (webProfile.profile !== 'local') throw new Error('Desktop requires the isolated local Web build; run pnpm build first.');
await mkdir(dist, { recursive: true });
await build({
  entryPoints: [join(root, 'src/main.ts')],
  outfile: join(dist, 'main.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'],
});
await build({
  entryPoints: [join(root, 'src/service.ts')],
  outfile: join(dist, 'service.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node24',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
await cp(new URL('../web/dist/', import.meta.url), join(dist, 'web'), { recursive: true });
await cp(new URL('../lab/config/models.yaml', import.meta.url), join(dist, 'models.yaml'));
await cp(new URL('../lab/data/lexicon/a1_a2.yaml', import.meta.url), join(dist, 'a1_a2.yaml'));
await writeFile(join(dist, 'package.json'), JSON.stringify({
  name: 'endless-desktop-test', productName: 'ENDLESS Test', version: metadata.version, private: true, main: 'main.cjs',
}, null, 2));
console.log(`Desktop runtime built: ${dist}`);
