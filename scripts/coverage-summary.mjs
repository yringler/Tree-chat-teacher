// Prints each package's coverage totals after `pnpm coverage` (which runs
// `vitest run --coverage` in every package): one row per package, from the
// `coverage/coverage-summary.json` its vitest run wrote (json-summary reporter,
// vitest.coverage.ts). Reporting only: it never fails on low numbers.
//
// `node scripts/coverage-summary.mjs path/to/file.ts …` also prints those files'
// rows (paths relative to the repository root).
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dirs = ['packages', 'apps'].flatMap((group) =>
  fs
    .readdirSync(path.join(root, group), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(group, d.name)),
);

const pct = (m) => (m.total === 0 ? '   -  ' : `${m.pct.toFixed(1).padStart(5)}%`);
const row = (name, s) =>
  `${name.padEnd(48)} ${pct(s.lines)}  ${pct(s.branches)}  ${pct(s.functions)}  ${pct(s.statements)}`;

console.log(`\n${'Coverage'.padEnd(48)}  lines  branches  funcs  stmts`);
const summaries = new Map();
for (const dir of dirs) {
  const file = path.join(root, dir, 'coverage', 'coverage-summary.json');
  if (!fs.existsSync(file)) continue;
  const summary = JSON.parse(fs.readFileSync(file, 'utf8'));
  summaries.set(dir, summary);
  console.log(row(dir, summary.total));
}
if (summaries.size === 0) console.log('(no coverage-summary.json found: run `pnpm coverage`)');

const wanted = process.argv.slice(2);
if (wanted.length > 0) {
  console.log('');
  for (const rel of wanted) {
    const abs = path.resolve(root, rel);
    const hit = [...summaries.values()].map((s) => s[abs]).find(Boolean);
    console.log(hit ? row(rel, hit) : `${rel.padEnd(48)} (not measured)`);
  }
}
