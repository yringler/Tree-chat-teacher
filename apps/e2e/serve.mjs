// The Worker the end-to-end tests run against (playwright.config.ts `webServer`):
// `wrangler dev` with its own local state and a config generated here, so neither
// apps/worker/.dev.vars nor the developer's local database is read or touched.
// Everything lives in apps/e2e/.state/ (git-ignored), recreated on every start:
//
// - e2e.env: the Worker's vars, passed with --env-file (which makes wrangler skip
//   .dev.vars). Real sign-in (Better Auth) with magic links printed to the console
//   (EMAIL_PROVIDER=log, localhost only) and Cloudflare's always-pass Turnstile test
//   keys; the membership on, sold by the fake payment provider (allowed only with
//   TEST_SEAMS, like the worker tests), so tests set memberships and credit through
//   its signed webhook; no model is ever called (see PROVIDERS / BUILT_IN_PROVIDER).
// - wrangler/: the local D1 database and Durable Objects, migrated before start.
// - wrangler.log: the server's output, where tests read magic links (tests/helpers.ts).
//
// wrangler dev runs the Worker's build.command (`pnpm -w build`) first, so the apps
// are built from the working tree.
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.E2E_PORT ?? 8790);
const here = import.meta.dirname;
const worker = path.resolve(here, '../worker');
const state = path.join(here, '.state');
const persist = path.join(state, 'wrangler');
const logFile = path.join(state, 'wrangler.log');
const envFile = path.join(state, 'e2e.env');

fs.rmSync(state, { recursive: true, force: true });
fs.mkdirSync(state, { recursive: true });

const vars = {
  PUBLIC_BASE_URL: `http://localhost:${PORT}`,
  BETTER_AUTH_SECRET: crypto.randomBytes(32).toString('base64'),
  KEY_ENCRYPTION_SECRET: crypto.randomBytes(32).toString('base64'),
  EMAIL_PROVIDER: 'log',
  TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
  TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
  // The fake payment provider and its webhook (billing/providers/fake.ts) need it.
  TEST_SEAMS: 'true',
  PAYMENT_PROVIDER: 'fake',
  FAKE_PAYMENTS: '',
  ANNUAL_FEE_ENABLED: 'true',
  POOL_ENABLED: 'false',
  PERSONAL_CREDIT_ENABLED: 'false',
  DEV_PURCHASES_ENABLED: 'false',
  AUTO_TITLE: 'false',
  // Share links for everyone, so the share dialog can be driven (share-dialog.spec.ts).
  DMCA_AGENT_REGISTERED: 'true',
  // Power's providers on the user's "own key": the offline test provider (it needs
  // none), and one that needs a key the tests never save (missing-key-power.spec.ts:
  // a conversation on it, opened in a browser without its key). It points nowhere.
  PROVIDERS: JSON.stringify([
    {
      id: 'fake',
      kind: 'fake',
      label: 'Fake',
      defaultModel: 'fake-1',
      models: [
        { id: 'fake-1', label: 'Fake 1' },
        // A small window (6,000 input tokens after the 600 reserved for the reply), so a
        // few long messages pass it and the context gets compacted (context-compaction.spec.ts).
        { id: 'fake-small', label: 'Fake small', maxContextTokens: 6600, maxOutputTokens: 600 },
      ],
      options: { chunkSize: 8 },
    },
    {
      id: 'keyed',
      kind: 'openai-compatible',
      label: 'Keyed',
      baseUrl: 'http://127.0.0.1:9/v1',
      // Never set: without it a keyless baseUrl would count as a local server, needing no key.
      apiKeySecret: 'KEYED_API_KEY',
      defaultModel: 'keyed-1',
      models: [{ id: 'keyed-1', label: 'Keyed 1' }],
    },
  ]),
  // The built-in provider (Learn, and power's Tangent credit). It must need a key, so
  // Learn on the user's own key asks for one (a fake needs none). It points nowhere:
  // an own-key send without a key is refused before any call, and a send on credit
  // (missing-key-power.spec.ts) gets its message written and its reply fails at once.
  BUILT_IN_PROVIDER: JSON.stringify({
    id: 'openrouter',
    kind: 'openai-compatible',
    label: 'Tangent',
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKeySecret: 'BUILT_IN_API_KEY',
    // Learn's tiers: Normal is the default.
    defaultModel: 'normal',
    models: [
      { id: 'normal', label: 'Normal', tier: 'normal' },
      { id: 'max', label: 'Max', tier: 'max' },
    ],
  }),
  BUILT_IN_API_KEY: 'sk-or-e2e-unused',
  // Credit holds each call at its model's price, and refuses a model without one. The daily
  // sync only lists OpenRouter, which this endpoint isn't, so the tiers are priced here, as a
  // deployment on another endpoint must: Normal at V4.1 Flash's price, Max at Sonnet's.
  MODEL_PRICES: JSON.stringify({
    normal: { in: 150_000, out: 600_000, context: 1_048_576 },
    max: { in: 2_000_000, out: 10_000_000, context: 1_000_000 },
  }),
};
// dotenv: single quotes keep JSON's double quotes literal.
fs.writeFileSync(
  envFile,
  Object.entries(vars)
    .map(([k, v]) => `${k}='${v}'`)
    .join('\n') + '\n',
);

const wrangler = path.join(worker, 'node_modules', '.bin', 'wrangler');
execFileSync(wrangler, ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persist], {
  cwd: worker,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, CI: 'true' },
});

const log = fs.createWriteStream(logFile);
const child = spawn(
  wrangler,
  [
    'dev',
    '--port',
    String(PORT),
    '--local-upstream',
    `localhost:${PORT}`,
    '--persist-to',
    persist,
    '--env-file',
    envFile,
    '--show-interactive-dev-session=false',
    '--live-reload=false',
  ],
  { cwd: worker, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: 'true' } },
);
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', (chunk) => {
    log.write(chunk);
    process.stdout.write(chunk);
  });
}
const stop = () => child.kill('SIGTERM');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
