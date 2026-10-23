// Fails when a cached task's hash misses a file its run reads, or takes in a file that changes on
// every run. Turbo hashes a package's own files and, through `transit`, its dependencies'. Tests
// that read other files name them in turbo.json's `inputs`; this checks those globs resolve to the
// files, so a typo can't turn into a stale cached pass. Add a row when a test starts reading
// outside its package.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');

/** Files outside each task's package that must be in its hash, from the repository root. */
const READS = {
  // copy-rules.spec.ts reads every app's templates; tangent-help-parity.spec.ts the Dart copy and
  // title prefix; learn-reply-parity.spec.ts the Dart copy of the Advanced settings.
  '@tangent/web-shared#test': [
    'apps/simple/src/app/app.ts',
    'apps/admin/src/app/app.ts',
    'apps/flutter/lib/ui/tangent_help_copy.dart',
    'apps/flutter/lib/ui/lesson_outline.dart',
    'apps/flutter/lib/state/learn_reply.dart',
  ],
  '@tangent/web-shared#coverage': [
    'apps/simple/src/app/app.ts',
    'apps/admin/src/app/app.ts',
    'apps/flutter/lib/ui/tangent_help_copy.dart',
    'apps/flutter/lib/ui/lesson_outline.dart',
    'apps/flutter/lib/state/learn_reply.dart',
  ],
  // learn-app.test.ts imports the power app's _headers; config-surface.test.ts the config doc.
  '@tangent/worker#test': ['apps/web/public/_headers', 'docs/configuration.md'],
  '@tangent/worker#coverage': ['apps/web/public/_headers', 'docs/configuration.md'],
  // The tests import web-shared's demo seed by path, which imports the other packages.
  '@tangent/e2e#typecheck': [
    'packages/web-shared/src/demo/seed.ts',
    'packages/shared/src/index.ts',
  ],
};

/** Paths an `inputs` glob can reach that are build output, installs or turbo's own logs. */
const GENERATED = /(^|\/)(node_modules|\.turbo|dist|coverage|\.angular|\.wrangler)\//;

const run = spawnSync(
  path.join(root, 'node_modules', '.bin', 'turbo'),
  ['run', 'test', 'coverage', 'typecheck', '--dry=json'],
  { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
if (run.status !== 0) {
  console.error(run.stderr);
  console.error('check-turbo-inputs: `turbo run --dry=json` failed.');
  process.exit(1);
}

const problems = [];
const tasks = new Map(JSON.parse(run.stdout).tasks.map((t) => [t.taskId, t]));
for (const [id, files] of Object.entries(READS)) {
  const task = tasks.get(id);
  if (!task) {
    problems.push(`${id} isn't in the task graph`);
    continue;
  }
  const inputs = new Set(
    Object.keys(task.inputs).map((f) => path.relative(root, path.join(root, task.directory, f))),
  );
  for (const file of files) {
    if (!inputs.has(file)) problems.push(`${id} doesn't hash ${file}`);
  }
}
for (const task of tasks.values()) {
  const generated = Object.keys(task.inputs).find((f) => GENERATED.test(f));
  if (generated) problems.push(`${task.taskId} hashes ${generated}, which never matches twice`);
}

if (problems.length > 0) {
  for (const p of problems) console.error(`check-turbo-inputs: ${p}`);
  console.error("Fix the task's `inputs` in turbo.json.");
  process.exit(1);
}
