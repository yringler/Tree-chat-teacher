import { defineConfig } from 'vitest/config';

/** The streaming benchmark (`pnpm --filter @tangent/render bench`), apart from `pnpm test`. */
export default defineConfig({
  test: { include: ['bench/**/*.perf.ts'], testTimeout: 600_000 },
});
