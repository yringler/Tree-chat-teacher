// The live contract suite (test/live, docs/runbooks/live-contract-tests.md): real
// providers on real keys, through the Worker's own adapters, meters and settlement, in
// workerd as in production. Never part of `pnpm test`: it spends money, so it runs only
// with TANGENT_LIVE=1 and an OpenRouter key, from `pnpm test:live`.
//
// Like .dev.vars, this file is build tooling: it reads the TANGENT_LIVE_* vars of the
// shell and hands the keys to the Worker under their production secret names, where
// config.ts reads them as it always does.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { defineConfig } from 'vitest/config';
import { LIVE_HARNESS_BINDINGS, LIVE_KEY_BINDINGS } from './test/live/bindings.js';
import { createLiveHost } from './test/live/host.js';

function liveVar(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

const FIXTURES = path.join(import.meta.dirname, '../../packages/providers/test/fixtures/live');

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/**
 * The run's keys, as the Worker's secrets, and its host. Read when the suite starts,
 * not when the file loads, so tools that only read the config (knip) need no keys.
 */
function liveRun(): {
  keyBindings: Record<string, string>;
  host: ReturnType<typeof createLiveHost>;
} {
  if (liveVar('TANGENT_LIVE') !== '1')
    throw new Error('The live suite spends real money: set TANGENT_LIVE=1 to run it.');
  const openrouterKey = liveVar('TANGENT_LIVE_OPENROUTER_KEY');
  if (!openrouterKey) throw new Error('The live suite needs TANGENT_LIVE_OPENROUTER_KEY.');
  const anthropicKey = liveVar('TANGENT_LIVE_ANTHROPIC_KEY');
  const openaiKey = liveVar('TANGENT_LIVE_OPENAI_KEY');
  const budgetUsd = Number(liveVar('TANGENT_LIVE_BUDGET_USD') ?? '1.00');
  if (!(budgetUsd > 0 && budgetUsd <= 20))
    throw new Error('TANGENT_LIVE_BUDGET_USD must be a dollar amount above 0 and at most 20.');

  const keyBindings: Record<string, string> = {};
  for (const name of LIVE_KEY_BINDINGS.openrouter) keyBindings[name] = openrouterKey;
  if (anthropicKey)
    for (const name of LIVE_KEY_BINDINGS.anthropic) keyBindings[name] = anthropicKey;
  if (openaiKey) for (const name of LIVE_KEY_BINDINGS.openai) keyBindings[name] = openaiKey;

  const host = createLiveHost({
    budgetUsd,
    allowUnlimitedKey: liveVar('TANGENT_LIVE_ALLOW_UNLIMITED_KEY') === '1',
    record: liveVar('TANGENT_LIVE_RECORD') === '1',
    secrets: [openrouterKey, anthropicKey, openaiKey].filter((k): k is string => !!k),
    writeReport: (markdown) => write(path.join(import.meta.dirname, '.live/report.md'), markdown),
    writeFixture: (file, json) => write(path.join(FIXTURES, file), json),
  });
  return { keyBindings, host };
}

/** One run, one host: its budget and report span every file. */
let run: ReturnType<typeof liveRun> | null = null;

/** The scenarios run in file-name order: the preflight first, the postflight last. */
class ByFileName extends BaseSequencer {
  override sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return Promise.resolve([...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId)));
  }
}

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      run ??= liveRun();
      return {
        main: './src/index.ts',
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, 'migrations')),
            ...LIVE_HARNESS_BINDINGS,
            ...run.keyBindings,
          },
          d1Databases: { DB: 'tangent-live' },
          ratelimits: {
            CHAT_RATE_LIMITER: { namespace_id: '1002', simple: { limit: 30, period: 60 } },
            KEY_RATE_LIMITER: { namespace_id: '1003', simple: { limit: 1000, period: 60 } },
          },
          outboundService: run.host,
        },
      };
    }),
  ],
  test: {
    name: 'live',
    include: ['test/live/*.live.ts'],
    setupFiles: ['./test/apply-migrations.ts'],
    // One runtime, one file at a time, in order: the budget and the report are one
    // sequence, and a provider's rate limit is no reason to fail a scenario twice over.
    isolate: false,
    fileParallelism: false,
    maxWorkers: 1,
    retry: 0,
    sequence: { sequencer: ByFileName },
    // Real calls, retried on rate limits, and generation lookups at production's delays.
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
