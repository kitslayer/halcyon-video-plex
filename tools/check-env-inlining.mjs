#!/usr/bin/env node
/**
 * Guards the build-time env vars against a silent-failure mode.
 *
 * Vite substitutes `import.meta.env.VITE_FOO` at build time only when that
 * exact expression appears in the source. Writing it defensively —
 * `(import.meta as any)?.env?.VITE_FOO` — still type-checks, still looks
 * correct, and still *builds*: the value even lands in the bundle's env object.
 * But the optional chain stops the substitution at the read site, so at runtime
 * `import.meta.env` is plain `undefined` in a browser and the baked-in value is
 * never read. A Docker image built with `--build-arg VITE_MEDIA_BACKEND=plex`
 * then quietly defaults to Jellyfin, and nothing anywhere reports an error.
 *
 * So: check the SOURCE for the broken shape, and check a real BUILD actually
 * inlines the value at the point of use.
 *
 *   node tools/check-env-inlining.mjs
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
let failed = false;
const fail = (msg) => { console.error(`✗ ${msg}`); failed = true; };

// ─── 1. No optional-chained import.meta anywhere in src/ ────────────────────

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

// `import.meta?.` or `(import.meta as any)?.` — both defeat substitution.
const BROKEN = /\(?\s*import\s*\.\s*meta\s*(?:as\s+\w+\s*)?\)?\s*\?\./;

/** Blank out comments so prose ABOUT the broken form doesn't trip the check —
 *  backend.ts documents it on purpose, which is exactly what this used to
 *  flag. Crude but sufficient: this only ever needs to spot real code. */
function stripComments(line, state) {
  let out = line;
  if (state.inBlock) {
    const end = out.indexOf('*/');
    if (end === -1) return '';
    out = ' '.repeat(end + 2) + out.slice(end + 2);
    state.inBlock = false;
  }
  const block = out.indexOf('/*');
  if (block !== -1 && out.indexOf('*/', block) === -1) {
    state.inBlock = true;
    out = out.slice(0, block);
  }
  const line2 = out.indexOf('//');
  if (line2 !== -1) out = out.slice(0, line2);
  return out;
}

for (const file of walk(join(ROOT, 'src'))) {
  const state = { inBlock: false };
  readFileSync(file, 'utf8').split('\n').forEach((raw, i) => {
    if (BROKEN.test(stripComments(raw, state))) {
      fail(`${file.replace(ROOT, '')}:${i + 1} optional-chains import.meta — Vite ` +
           `will not inline this. Use \`typeof import.meta.env !== 'undefined' ? ` +
           `import.meta.env.VITE_X : undefined\`.`);
    }
  });
}

// ─── 2. A real build inlines the value where it is USED ─────────────────────

const SENTINEL = 'plex';
console.log(`Building with VITE_MEDIA_BACKEND=${SENTINEL}…`);
execFileSync('npx', ['vite', 'build'], {
  cwd: ROOT,
  env: { ...process.env, VITE_MEDIA_BACKEND: SENTINEL },
  stdio: 'pipe',
});

const assets = join(ROOT, 'dist', 'assets');
if (!existsSync(assets)) fail('no dist/assets after build');
else {
  const main = readdirSync(assets).find((f) => /^main-.*\.js$/.test(f));
  if (!main) fail('no dist/assets/main-*.js after build');
  else {
    const js = readFileSync(join(assets, main), 'utf8');
    // The read site must be gone: if `import.meta` still appears next to the
    // var name, the access was not substituted.
    if (/import\s*\.\s*meta[^;]{0,80}VITE_MEDIA_BACKEND/.test(js)) {
      fail('bundle still reads VITE_MEDIA_BACKEND through a live `import.meta` — ' +
           'the value will be undefined at runtime');
    }
    if (!js.includes(`VITE_MEDIA_BACKEND:"${SENTINEL}"`)) {
      fail(`bundle does not carry VITE_MEDIA_BACKEND:"${SENTINEL}"`);
    }
  }
}

if (failed) {
  console.error('\nenv inlining check FAILED');
  process.exit(1);
}
console.log('✓ build-time env vars inline correctly');
