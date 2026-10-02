#!/usr/bin/env node
// Assembles the Workers Static Assets directory (apps/worker/site) from the two
// Angular builds (PLAN §2.8):
//   apps/web/dist/web/browser/**       → apps/worker/site/        (power app, `/`)
//   apps/simple/dist/simple/browser/** → apps/worker/site/learn/  (simple app, `/learn/`)
// Run by the root `pnpm build` after both `ng build`s. Pure Node fs, no deps.
import { cpSync, existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'apps/worker/site');
const sources = [
  {
    from: path.join(root, 'apps/web/dist/web/browser'),
    to: site,
    build: 'pnpm --filter @tangent/web build',
  },
  {
    from: path.join(root, 'apps/simple/dist/simple/browser'),
    to: path.join(site, 'learn'),
    build: 'pnpm --filter @tangent/simple build',
  },
];
// Kept across runs: git tracks it so the directory exists before any build
// (wrangler and vitest-pool-workers both read `assets.directory`).
const KEEP = new Set(['.gitkeep']);
// Only meaningful at the root of the assets directory; a copy under learn/ would be served as a file.
const ROOT_ONLY = new Set(['_headers', '_redirects']);

function fail(message) {
  console.error(`assemble-assets: ${message}`);
  process.exit(1);
}

for (const { from, build } of sources) {
  if (!existsSync(from) || !statSync(from).isDirectory()) {
    fail(`missing build output ${path.relative(root, from)} (run \`${build}\` first)`);
  }
  if (!existsSync(path.join(from, 'index.html'))) {
    fail(`${path.relative(root, from)} has no index.html (incomplete build?)`);
  }
}

if (existsSync(site)) {
  for (const entry of readdirSync(site)) {
    if (!KEEP.has(entry)) rmSync(path.join(site, entry), { recursive: true, force: true });
  }
}

for (const [i, { from, to }] of sources.entries()) {
  const nested = i > 0;
  cpSync(from, to, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (src) => !(nested && path.dirname(src) === from && ROOT_ONLY.has(path.basename(src))),
  });
  console.log(`assemble-assets: ${path.relative(root, from)} → ${path.relative(root, to)}`);
}

// Don't publish the placeholder as an asset.
writeFileSync(path.join(site, '.assetsignore'), '.gitkeep\n');
