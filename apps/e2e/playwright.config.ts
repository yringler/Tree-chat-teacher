import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests: Chromium against `wrangler dev` (serve.mjs), on a local
 * database of their own, with no model calls. `pnpm e2e` from the repository root.
 *
 * The suites share one server and its database, so they run one at a time.
 * `@playwright/test` is pinned to the release whose Chromium build is installed
 * (`pnpm --filter @tangent/e2e exec playwright install chromium` elsewhere);
 * PLAYWRIGHT_CHROMIUM_PATH points at another Chromium binary instead.
 */
const PORT = Number(process.env.E2E_PORT ?? 8790);
const BASE_URL = `http://localhost:${PORT}`;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
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
    command: 'node serve.mjs',
    url: `${BASE_URL}/api/login-options`,
    // wrangler dev builds every app before it listens.
    timeout: 300_000,
    // E2E_REUSE_SERVER=1: use a `node serve.mjs` already running (while writing tests).
    reuseExistingServer: !!process.env.E2E_REUSE_SERVER,
    stdout: 'ignore',
    stderr: 'pipe',
    env: { E2E_PORT: String(PORT) },
  },
});
