#!/usr/bin/env node
// Fails when a payment provider is named where no provider should be
// (docs/polar-migration/03-architecture.md §5): the shared packages and the
// browser apps talk to the billing API only, so a provider switch never
// touches them. Provider names belong in the Worker's adapter
// (apps/worker/src/billing/providers/), its config, the legal pages and the
// README. Run by `pnpm lint`.
import { execFileSync } from 'node:child_process';

/** Provider names, as words or in identifiers (`stripeStatus`, `POLAR_SERVER`). */
const PATTERN = 'stripe|polar';
/** Where they must not appear (git pathspecs). */
const PATHS = [
  ':(glob)packages/*/src/**',
  ':(glob)apps/web/src/**',
  ':(glob)apps/simple/src/**',
  ':(glob)apps/canvas/src/**',
  ':(glob)apps/admin/src/**',
];

let out = '';
try {
  out = execFileSync('git', ['grep', '-n', '-i', '-E', PATTERN, '--', ...PATHS], {
    encoding: 'utf8',
  });
} catch (err) {
  // git grep exits 1 when nothing matches: that is the passing case.
  if (err.status !== 1) throw err;
}

if (out.trim()) {
  console.error(
    'Payment providers must not be named in shared or browser code (see scripts/check-provider-neutral.mjs):',
  );
  console.error(out.trimEnd());
  process.exit(1);
}
