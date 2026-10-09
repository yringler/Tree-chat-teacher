import type { CoverageOptions } from 'vitest/node';

/**
 * Coverage settings every package's vitest config uses with `vitest run --coverage`
 * (`pnpm coverage`): reporting only, no thresholds. Each package measures its own
 * `src/` (files no test loads count as uncovered), into its own git-ignored
 * `coverage/`; `scripts/coverage-summary.mjs` prints the per-package totals.
 *
 * V8 coverage for the Node packages; the worker runs inside workerd
 * (`@cloudflare/vitest-pool-workers`), which only supports Istanbul's
 * instrumented coverage, so it passes `istanbul`.
 */
export function coverage(provider: 'v8' | 'istanbul' = 'v8'): CoverageOptions {
  return {
    provider,
    include: ['src/**/*.{ts,tsx}'],
    exclude: ['src/**/*.spec.ts', 'src/**/*.d.ts'],
    reporter: ['text-summary', 'json-summary', 'html'],
    reportsDirectory: './coverage',
  } as CoverageOptions;
}
