import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Performance harness for power mode with a heavy tree (power-tree.perf.ts).
 * Not part of `pnpm e2e`: run it with `pnpm --filter @tangent/e2e perf`.
 *
 * It needs no Worker: the power app is built into apps/web/dist/perf-<build>
 * and served statically (serve-static.mjs, with the SPA fallback), and the
 * test drives the in-browser demo at /demo. PERF_BUILD=prod (default) is the
 * production build with source maps (real costs; profiles are mapped back
 * to sources); PERF_BUILD=dev is the development build (readable names, but
 * Angular's dev-mode checks add their own cost). PERF_SKIP_BUILD=1 reuses the
 * last build.
 */
const PORT = Number(process.env.PERF_PORT ?? 8791);
const BUILD = process.env.PERF_BUILD === 'dev' ? 'dev' : 'prod';
const web = path.resolve(import.meta.dirname, '../../web');
const out = `dist/perf-${BUILD}`;
const ngConfig =
  BUILD === 'dev' ? '--configuration development' : '--configuration production --source-map';
const build = process.env.PERF_SKIP_BUILD
  ? 'true'
  : `pnpm --dir ${web} exec ng build ${ngConfig} --output-path ${out}`;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;

export default defineConfig({
  testDir: '.',
  testMatch: '*.perf.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  reporter: 'list',
  outputDir: '../test-results/perf-artifacts',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(executablePath ? { launchOptions: { executablePath } } : {}),
      },
    },
  ],
  webServer: {
    command: `${build} && node ${path.join(import.meta.dirname, 'serve-static.mjs')} ${path.join(web, out, 'browser')} ${PORT}`,
    url: `http://localhost:${PORT}/__perf_ready`,
    timeout: 300_000,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
