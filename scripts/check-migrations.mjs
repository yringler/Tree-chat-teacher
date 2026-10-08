// Fails when apps/worker/src/db/schema.ts and apps/worker/migrations disagree: drizzle-kit
// generates against a copy of the migrations, and any migration it writes is a schema
// change nobody wrote a migration for (README, "Database migrations"). The copy keeps the
// check from touching the repository.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const worker = path.join(import.meta.dirname, '..', 'apps', 'worker');
const drizzleKit = path.join(worker, 'node_modules', '.bin', 'drizzle-kit');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tangent-migrations-'));
const copy = path.join(root, 'migrations');
try {
  fs.cpSync(path.join(worker, 'migrations'), copy, { recursive: true });
  const before = new Set(fs.readdirSync(copy));
  // Run outside apps/worker, so drizzle.config.ts (whose `out` is the real folder) isn't
  // read; `--out` is relative because drizzle-kit resolves it against the working directory.
  // No stdin: a change drizzle-kit can't tell from a rename asks, and with no answer it fails.
  const run = spawnSync(
    drizzleKit,
    [
      'generate',
      '--dialect=sqlite',
      `--schema=${path.join(worker, 'src', 'db', 'schema.ts')}`,
      '--out=migrations',
    ],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 },
  );
  const added = fs.readdirSync(copy).filter((f) => !before.has(f));
  for (const f of added.filter((f) => f.endsWith('.sql'))) {
    console.error(`--- ${f}\n${fs.readFileSync(path.join(copy, f), 'utf8')}`);
  }
  if (added.length > 0) {
    console.error(
      'check-migrations: apps/worker/src/db/schema.ts has changes no migration has. Run `pnpm --filter @tangent/worker db:generate` and commit the migration.',
    );
    process.exit(1);
  }
  // drizzle-kit exits 0 on some errors (a malformed migrations folder), so only its
  // own "nothing to do" counts as agreement.
  if (run.status !== 0 || !run.stdout.includes('No schema changes')) {
    console.error(run.stdout, run.stderr, run.error ?? '');
    console.error('check-migrations: drizzle-kit generate did not confirm the schema (see above).');
    process.exit(1);
  }
  console.log('check-migrations: schema.ts and the migrations agree.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
