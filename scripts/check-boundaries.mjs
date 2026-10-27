import ts from 'typescript';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const slash = (path) => path.split(sep).join('/');
const root = fileURLToPath(new URL('..', import.meta.url));
const portablePackages = /^(?:packages\/(?:content|player|learning|esl|world))\//;
const portableDependencies = new Set(['zod', 'yaml', 'inkjs', 'inkjs/full', 'ts-fsrs']);

/** Include type imports, re-exports, literal dynamic imports and require calls. */
export function references(text, file = 'source.ts', runtimeOnly = false) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length) throw new Error(`Cannot parse ${file}`);
  const refs = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (runtimeOnly && (node.isTypeOnly || node.importClause?.isTypeOnly)) return;
      refs.push(node.moduleSpecifier.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      if (runtimeOnly) return;
      refs.push(node.argument.literal.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      refs.push(node.moduleReference.expression?.text);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const arg = node.arguments[0];
      if (!arg || !(ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
        throw new Error(`Non-literal module loading cannot be checked: ${file}`);
      }
      refs.push(arg.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...new Set(refs)];
}

function packagesAt(base) {
  const packages = new Map();
  for (const group of ['packages', 'apps']) {
    if (!existsSync(resolve(base, group))) continue;
    for (const row of readdirSync(resolve(base, group), { withFileTypes: true })) {
      const dir = resolve(base, group, row.name), manifest = resolve(dir, 'package.json');
      if (row.isDirectory() && existsSync(manifest)) {
        const json = JSON.parse(readFileSync(manifest, 'utf8'));
        packages.set(json.name, { dir, exports: json.exports });
      }
    }
  }
  return packages;
}

function sourceFile(path) {
  path = path.split('?')[0];
  const candidates = /\.js$/.test(path) ? [path.slice(0, -3) + '.ts', path.slice(0, -3) + '.tsx', path] :
    [path, path + '.ts', path + '.tsx', resolve(path, 'index.ts')];
  const file = candidates.find(p => existsSync(p) && /\.(?:[cm]?[jt]sx?|json|yaml|css|svg|png)$/.test(p));
  if (!file) throw new Error(`Unresolved internal import: ${path}`);
  return file;
}

/** Walk complete workspace source graphs; installed third-party code is outside this check. */
export function checkGraph(base, entries, forbidden, runtimeOnly = false) {
  const packages = packagesAt(base), seen = new Set(), errors = [];
  function walk(file, chain) {
    const name = slash(relative(base, file));
    if (forbidden(name)) { errors.push([...chain, name].join(' -> ')); return; }
    if (seen.has(file)) return;
    seen.add(file);
    if (!/\.[cm]?[jt]sx?$/.test(file)) return;
    for (const specifier of references(readFileSync(file, 'utf8'), name, runtimeOnly)) {
      let target;
      if (specifier.startsWith('.')) target = sourceFile(resolve(dirname(file), specifier));
      else if (specifier.startsWith('@endless/')) {
        const [scope, name, ...rest] = specifier.split('/');
        const pkg = packages.get(`${scope}/${name}`), key = rest.length ? './' + rest.join('/') : '.';
        const exported = pkg?.exports?.[key];
        if (typeof exported !== 'string') throw new Error(`Unexported workspace import: ${specifier}`);
        target = sourceFile(resolve(pkg.dir, exported));
      } else {
        // Contracts may depend on validation only, with no Node/browser/server adapters.
        if (name.startsWith('packages/cloud-contracts/') && specifier !== 'zod') {
          errors.push([...chain, name, specifier].join(' -> '));
        }
        if (portablePackages.test(name) && !portableDependencies.has(specifier)) {
          errors.push([...chain, name, specifier].join(' -> '));
        }
        continue;
      }
      walk(target, [...chain, name]);
    }
  }
  for (const entry of entries) walk(sourceFile(resolve(base, entry)), []);
  return errors;
}

function filesBelow(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(row => row.isDirectory()
    ? filesBelow(resolve(dir, row.name)) : /\.tsx?$/.test(row.name) ? [resolve(dir, row.name)] : []);
}

export function checkBoundaries(base = root) {
  const cloud = name => name.startsWith('packages/cloud-contracts/') ||
    name.startsWith('packages/content/src/cloud') || name === 'packages/content/src/reader-index.ts' ||
    name.startsWith('apps/api/src/cloud/') || name.startsWith('apps/web/src/cloud/');
  const rules = [
    ['native content/player', ['packages/content/src/index.ts', 'packages/player/src/index.ts'],
      name => cloud(name) || name.startsWith('apps/')],
    ['local API/desktop service', ['apps/api/src/main.ts', 'apps/desktop/src/service.ts'], cloud],
    ['cloud API/worker', filesBelow(resolve(base, 'apps/api/src/cloud')),
      name => name.startsWith('apps/') && !name.startsWith('apps/api/src/cloud/')],
    ['portable cloud contracts', filesBelow(resolve(base, 'packages/cloud-contracts/src')),
      name => !name.startsWith('packages/cloud-contracts/')],
    ['portable cloud content adapters', ['packages/content/src/cloud.ts'], name => name.startsWith('apps/')],
    ['native Web storage/player (including types)', ['apps/web/src/storage.ts', 'apps/web/src/use-player.ts', 'apps/web/src/session-writer.ts'], cloud],
    ['local Web runtime', ['apps/web/src/App.tsx', 'apps/web/src/integration.tsx'], cloud, true],
    ['cloud player isolation', ['apps/web/src/cloud/use-player.ts'], name => ['apps/web/src/api.ts', 'apps/web/src/storage.ts', 'apps/web/src/use-player.ts'].includes(name)],
  ];
  return rules.flatMap(([label, entries, forbidden, runtimeOnly]) => checkGraph(base, entries, forbidden, runtimeOnly).map(error => `${label}: ${error}`));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const errors = checkBoundaries();
    if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
    else console.log('Architecture boundaries passed (8 source graphs, including native Web and isolated player hooks).');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
