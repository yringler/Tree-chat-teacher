import { defineConfig } from 'vitest/config';

/** The scaling benchmarks (`pnpm --filter @tangent/core bench`), apart from `pnpm test`. */
export default defineConfig({
  test: { include: ['bench/**/*.perf.ts'], testTimeout: 600_000 },
});
