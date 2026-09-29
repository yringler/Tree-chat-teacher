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
          bindings: { TEST_MIGRATIONS: migrations, DEV_ALLOW_NO_AUTH: 'true' },
        },
      };
    }),
  ],
  test: {
    setupFiles: ['./test/apply-migrations.ts'],
  },
});
