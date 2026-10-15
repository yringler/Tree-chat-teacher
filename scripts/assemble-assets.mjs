#!/usr/bin/env node
// Assembles the Workers Static Assets directory (apps/worker/site) from the
// apps' builds:
//   apps/web/dist/web/browser/**       → apps/worker/site/         (power app, `/`)
//   apps/simple/dist/simple/browser/** → apps/worker/site/learn/   (simple app, `/learn/`)
//   apps/canvas/dist/canvas/browser/** → apps/worker/site/canvas/  (canvas app, `/canvas/`)
//   apps/admin/dist/admin/browser/**   → apps/worker/site/admin/   (admin app, `/admin/`)
//   apps/flutter/dist/web/**           → apps/worker/site/app/     (Flutter app, `/app/`)
// Run by the root `pnpm build` after the `ng build`s and `flutter build web`. Pure Node fs, no deps.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
  {
    from: path.join(root, 'apps/canvas/dist/canvas/browser'),
    to: path.join(site, 'canvas'),
    build: 'pnpm --filter @tangent/canvas build',
  },
  {
    from: path.join(root, 'apps/admin/dist/admin/browser'),
    to: path.join(site, 'admin'),
    build: 'pnpm --filter @tangent/admin build',
  },
  {
    from: path.join(root, 'apps/flutter/dist/web'),
    to: path.join(site, 'app'),
    build: 'pnpm --filter @tangent/flutter build',
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
  mkdirSync(to, { recursive: true });
  // Entry by entry: newer Node versions apply errorOnExist to an existing destination
  // directory, which `to` already is. Per entry it still fails when two sources
  // would write the same path.
  for (const entry of readdirSync(from)) {
    if (nested && ROOT_ONLY.has(entry)) continue;
    cpSync(path.join(from, entry), path.join(to, entry), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
  console.log(`assemble-assets: ${path.relative(root, from)} → ${path.relative(root, to)}`);
}

// Don't publish the placeholder as an asset.
writeFileSync(path.join(site, '.assetsignore'), '.gitkeep\n');
