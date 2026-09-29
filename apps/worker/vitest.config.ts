import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
      return {
        main: './src/index.ts',
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          // Test-only bindings: migrations to apply, and dev auth bypass.
          bindings: {
            TEST_MIGRATIONS: migrations,
            DEV_ALLOW_NO_AUTH: 'true',
            AUTO_TITLE: 'false',
            PROVIDERS: JSON.stringify([
              { id: 'fake', kind: 'fake', label: 'Fake', defaultModel: 'fake-1', models: [{ id: 'fake-1', label: 'Fake 1' }], options: { chunkSize: 4 } },
              { id: 'slow', kind: 'fake', label: 'Slow', defaultModel: 'fake-1', models: [{ id: 'fake-1', label: 'Fake 1' }], options: { chunkSize: 2, delayMs: 30 } },
            ]),
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ['./test/apply-migrations.ts'],
  },
});
