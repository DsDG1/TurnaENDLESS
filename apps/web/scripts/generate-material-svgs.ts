import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { materialBackgrounds, materialCharacters, materialProps } from '@endless/content';
import { Character, PropArt, SceneBackdrop } from '../src/components/art.js';

const root = path.resolve(import.meta.dirname, '../../..');
const contentSvgDir = path.join(root, 'packages/content/materials/svg');
const webPublicDir = path.join(root, 'apps/web/public/materials');

const dirs = [
  path.join(contentSvgDir, 'characters'),
  path.join(contentSvgDir, 'backgrounds'),
  path.join(contentSvgDir, 'props'),
  path.join(webPublicDir, 'characters'),
  path.join(webPublicDir, 'backgrounds'),
  path.join(webPublicDir, 'props'),
];

for (const dir of dirs) {
  fs.mkdirSync(dir, { recursive: true });
}

interface MaterialManifestItem {
  id: string;
  category: 'character' | 'background' | 'prop';
  label: string;
  tags: string[];
  svgPath: string;
}

const manifest: MaterialManifestItem[] = [];

// 1. Characters
for (const char of materialCharacters) {
  const svg = renderToStaticMarkup(createElement(Character, { kind: char.id }));
  const filename = `${char.id}.svg`;
  fs.writeFileSync(path.join(contentSvgDir, 'characters', filename), svg, 'utf-8');
  fs.writeFileSync(path.join(webPublicDir, 'characters', filename), svg, 'utf-8');
  manifest.push({
    id: char.id,
    category: 'character',
    label: char.label,
    tags: [...char.tags],
    svgPath: `characters/${filename}`,
  });
}

// 2. Backgrounds
for (const bg of materialBackgrounds) {
  const svg = renderToStaticMarkup(createElement(SceneBackdrop, { tag: `@tag:${bg.id}` }));
  const filename = `${bg.id}.svg`;
  fs.writeFileSync(path.join(contentSvgDir, 'backgrounds', filename), svg, 'utf-8');
  fs.writeFileSync(path.join(webPublicDir, 'backgrounds', filename), svg, 'utf-8');
  manifest.push({
    id: bg.id,
    category: 'background',
    label: bg.label,
    tags: [...bg.tags],
    svgPath: `backgrounds/${filename}`,
  });
}

// 3. Props
for (const prop of materialProps) {
  const svg = renderToStaticMarkup(createElement(PropArt, { reference: `@emoji:${prop.id}` }));
  const filename = `${prop.id}.svg`;
  fs.writeFileSync(path.join(contentSvgDir, 'props', filename), svg, 'utf-8');
  fs.writeFileSync(path.join(webPublicDir, 'props', filename), svg, 'utf-8');
  manifest.push({
    id: prop.id,
    category: 'prop',
    label: prop.label,
    tags: [...prop.tags],
    svgPath: `props/${filename}`,
  });
}

const manifestJson = JSON.stringify({
  version: 1,
  total: manifest.length,
  counts: {
    characters: materialCharacters.length,
    backgrounds: materialBackgrounds.length,
    props: materialProps.length,
  },
  materials: manifest,
}, null, 2);

fs.writeFileSync(path.join(root, 'packages/content/materials/manifest.json'), manifestJson, 'utf-8');
fs.writeFileSync(path.join(webPublicDir, 'manifest.json'), manifestJson, 'utf-8');

console.log(`Successfully generated ${manifest.length} SVG material files:`);
console.log(`- Characters: ${materialCharacters.length}`);
console.log(`- Backgrounds: ${materialBackgrounds.length}`);
console.log(`- Props: ${materialProps.length}`);
