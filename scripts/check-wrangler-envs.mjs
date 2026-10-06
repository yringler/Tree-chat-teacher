#!/usr/bin/env node
// Fails when a Wrangler environment of the Worker (apps/worker/wrangler.jsonc `env`, e.g. the
// sandbox Worker; README "Sandbox Worker") drifts from the top level or shares its state:
//
// - Wrangler doesn't inherit `vars` or bindings into an environment, so a var or binding added at
//   the top level and forgotten in `env.<name>` is simply missing there (the code then reads its
//   default, or the binding is undefined). Every environment must define the same var names and
//   the same binding names as the top level.
// - An environment must not reach production's state: its own routes, D1 database and rate limit
//   namespaces, Polar's sandbox server and none of production's Polar product ids.
//
// Run by `pnpm lint`.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const file = path.join(import.meta.dirname, '../apps/worker/wrangler.jsonc');
const { config, error } = ts.parseConfigFileTextToJson(file, fs.readFileSync(file, 'utf8'));
if (error) {
  console.error(`${file}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`);
  process.exit(1);
}

/** Binding keys whose entries are named by `binding` or `name` (none of them inherited). */
const BINDING_LISTS = [
  'd1_databases',
  'kv_namespaces',
  'r2_buckets',
  'ratelimits',
  'services',
  'queues',
  'analytics_engine_datasets',
  'vectorize',
  'hyperdrive',
  'workflows',
];
/** Vars whose production values an environment must not reuse (empty is allowed). */
const PRODUCTION_ONLY_VARS = ['POLAR_CREDITS_PRODUCT_ID', 'POLAR_MEMBERSHIP_PRODUCT_ID'];

const names = (list) => (list ?? []).map((b) => b.binding ?? b.name).sort();
const routes = (c) =>
  (c.routes ?? (c.route ? [c.route] : [])).map((r) => (typeof r === 'string' ? r : r.pattern));
const diff = (a, b) => a.filter((x) => !b.includes(x));

const problems = [];
for (const [envName, env] of Object.entries(config.env ?? {})) {
  const at = `env.${envName}`;
  const report = (msg) => problems.push(`${at}: ${msg}`);

  const topVars = Object.keys(config.vars ?? {});
  const envVars = Object.keys(env.vars ?? {});
  const missingVars = diff(topVars, envVars);
  const extraVars = diff(envVars, topVars);
  if (missingVars.length) report(`vars missing (vars aren't inherited): ${missingVars.join(', ')}`);
  if (extraVars.length) report(`vars not at the top level: ${extraVars.join(', ')}`);

  for (const key of BINDING_LISTS) {
    const top = names(config[key]);
    const own = names(env[key]);
    if (top.join() !== own.join())
      report(`${key} bindings [${own}] differ from the top level's [${top}]`);
  }
  const topDo = names(config.durable_objects?.bindings);
  const envDo = names(env.durable_objects?.bindings);
  if (topDo.join() !== envDo.join()) {
    report(`durable_objects bindings [${envDo}] differ from the top level's [${topDo}]`);
  }

  // Isolation from production.
  const envRoutes = routes(env);
  if (!envRoutes.length) report("no routes of its own (it would inherit production's)");
  const sharedRoutes = envRoutes.filter((r) => routes(config).includes(r));
  if (sharedRoutes.length) report(`routes shared with production: ${sharedRoutes.join(', ')}`);

  const topDbIds = (config.d1_databases ?? []).map((d) => d.database_id);
  for (const db of env.d1_databases ?? []) {
    if (topDbIds.includes(db.database_id))
      report(`D1 binding ${db.binding} uses production's database`);
  }
  const topLimitIds = (config.ratelimits ?? []).map((r) => String(r.namespace_id));
  for (const rl of env.ratelimits ?? []) {
    if (topLimitIds.includes(String(rl.namespace_id))) {
      report(`rate limiter ${rl.name} shares production's namespace_id ${rl.namespace_id}`);
    }
  }

  if (env.vars?.POLAR_SERVER !== 'sandbox') report('POLAR_SERVER must be "sandbox"');
  for (const key of PRODUCTION_ONLY_VARS) {
    const value = env.vars?.[key];
    if (value && value === config.vars?.[key]) report(`${key} is production's product`);
  }
}

if (problems.length) {
  console.error(
    'Wrangler environments out of step with apps/worker/wrangler.jsonc (see scripts/check-wrangler-envs.mjs):',
  );
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
