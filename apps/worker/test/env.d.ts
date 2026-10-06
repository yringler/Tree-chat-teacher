import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      /** Empty until a test applies migrations to it (vitest.config.ts). */
      MIGRATION_DB: D1Database;
      /** Empty until test/migrations-node-links.test.ts applies migrations to it. */
      LINKS_MIGRATION_DB: D1Database;
      KEY_ENCRYPTION_SECRET: string;
    }
  }
}
