#!/usr/bin/env node
// Fails on any runtime import cycle in the apps and packages. A cycle makes a
// module's exports depend on evaluation order: one side sees the other's
// bindings uninitialised, and which side breaks changes with whoever imports
// first. Type-only imports (`import type`) are erased, so they are skipped.
// Run by `pnpm lint`.
import madge from 'madge';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const DIRS = ['apps', 'packages'].flatMap((group) =>
  readdirSync(join(ROOT, group), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(ROOT, group, d.name, 'package.json')))
    .map((d) => join(ROOT, group, d.name)),
);

const res = await madge(DIRS, {
  baseDir: ROOT,
  fileExtensions: ['ts', 'mjs'],
  // Dependencies, build output and generated files.
  excludeRegExp: [
    /\.d\.ts$/,
    /(^|\/)(node_modules|dist|coverage|\.angular|\.wrangler|test-results|playwright-report)\//,
    /^apps\/worker\/site\//,
  ],
  tsConfig: join(ROOT, 'tsconfig.base.json'),
  detectiveOptions: {
    ts: { skipTypeImports: true },
    tsx: { skipTypeImports: true },
  },
});

const cycles = res.circular();
if (cycles.length > 0) {
  console.error(`Runtime import cycles (${cycles.length}, see scripts/check-cycles.mjs):`);
  for (const cycle of cycles) console.error(`  ${[...cycle, cycle[0]].join(' -> ')}`);
  process.exit(1);
}
