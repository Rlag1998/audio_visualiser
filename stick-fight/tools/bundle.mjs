#!/usr/bin/env node
// Flattens the ES module tree into one self-contained HTML file.
//
//   node tools/bundle.mjs dist/stick-fight.html
//
// Useful for sharing the game as a single file, or running it straight off disk
// where the module loader would otherwise be blocked by file:// CORS.
//
// The modules have no circular imports and no default exports, so concatenating
// them in dependency order with the import/export syntax stripped is equivalent
// to what the browser's loader builds — provided no two modules declare the same
// top-level name. This script verifies that rather than assuming it, and exits
// non-zero if the assumption ever stops holding.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Dependency order: every module appears after everything it imports. */
const ORDER = [
  'src/core/math.js',
  'src/core/rng.js',
  'src/game/config.js',
  'src/game/pose.js',
  'src/game/skeleton.js',
  'src/game/moves.js',
  'src/game/ragdoll.js',
  'src/game/fighter.js',
  'src/game/ai.js',
  'src/game/match.js',
  'src/sim/batch.js',
  'src/render/camera.js',
  'src/render/particles.js',
  'src/render/renderer.js',
  'src/render/hud.js',
  'src/audio/sfx.js',
  'src/input/input.js',
  'src/input/touch.js',
  'src/ui/ui.js',
  'src/main.js',
];

const outPath = process.argv[2] ?? join(ROOT, 'dist', 'stick-fight.html');

const parts = [];
const owners = new Map();
const collisions = [];

for (const rel of ORDER) {
  let code = readFileSync(join(ROOT, rel), 'utf8');

  code = code.replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]*['"]\s*;?[ \t]*$/gm, '');
  code = code.replace(/^export\s*\{[^}]*\}\s*;?[ \t]*$/gm, '');
  code = code.replace(/^export\s+/gm, '');

  const leftover = code.split('\n').filter((l) => /^\s*(import|export)\s/.test(l));
  if (leftover.length) {
    console.error(`! ${rel}: unhandled module syntax:\n  ${leftover.join('\n  ')}`);
    process.exit(1);
  }

  const re = /^(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(code))) {
    if (owners.has(m[1])) collisions.push(`${m[1]}: ${owners.get(m[1])} vs ${rel}`);
    else owners.set(m[1], rel);
  }

  parts.push(`// ===== ${rel} ${'='.repeat(Math.max(0, 58 - rel.length))}\n${code.trim()}\n`);
}

if (collisions.length) {
  console.error('! top-level name collisions — concatenation is not safe:\n  ' + collisions.join('\n  '));
  process.exit(1);
}

const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const tag = '<script type="module" src="./src/main.js"></script>';
if (!html.includes(tag)) {
  console.error('! could not find the module script tag in index.html');
  process.exit(1);
}

const out = html.replace(tag, `<script type="module">\n${parts.join('\n')}\n</script>`);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, out);

console.log(`${ORDER.length} modules, ${owners.size} top-level names, no collisions`);
console.log(`${(out.length / 1024).toFixed(0)}KB -> ${outPath}`);
