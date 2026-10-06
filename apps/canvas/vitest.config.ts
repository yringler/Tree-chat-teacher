import { defineConfig } from 'vitest/config';
import { coverage } from '../../vitest.coverage.js';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    coverage: coverage(),
  },
});
