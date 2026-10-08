#!/usr/bin/env node
// Writes apps/worker/wrangler.deploy.json: apps/worker/wrangler.jsonc without its `build` key, for
// the deploy job in .github/workflows/ci.yml. `wrangler deploy` runs build.command before every
// upload and has no flag to skip it; with this config it uploads the apps/worker/site the job
// already built and checked, and the Cloudflare token never shares a process tree with the apps'
// build toolchain. Written next to wrangler.jsonc, so its relative paths still resolve.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const worker = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/worker');
const source = path.join(worker, 'wrangler.jsonc');
const target = path.join(worker, 'wrangler.deploy.json');

// TypeScript's tsconfig reader takes JSON with comments and trailing commas, as wrangler does.
const { config, error } = ts.parseConfigFileTextToJson(source, readFileSync(source, 'utf8'));
if (error || typeof config !== 'object' || config === null) {
  console.error(`deploy-config: can't parse ${path.relative(process.cwd(), source)}`);
  process.exit(1);
}
delete config.build;
writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
console.log(`deploy-config: wrote ${path.relative(process.cwd(), target)} (no build)`);
