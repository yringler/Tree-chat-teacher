// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.angular/**',
      '**/.wrangler/**',
      '**/worker-configuration.d.ts',
      'apps/worker/migrations/**',
      '.claude/**',
      'apps/worker/site/**',
      // Generated: coverage reports (pnpm coverage) and end-to-end runs (apps/e2e).
      '**/coverage/**',
      'apps/e2e/.state/**',
      'apps/e2e/test-results/**',
      'apps/e2e/playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-extraneous-class': 'off',
      '@typescript-eslint/unified-signatures': 'off',
      'no-undef': 'off',
    },
  },
  // Payment boundaries (docs/polar-migration/03-architecture.md §2.7): the
  // Polar SDK is imported only by its adapter (and its tests), and adapters
  // translate without reaching into the ledger, purchases, the domain
  // handler or the pool.
  {
    files: ['**/*.ts'],
    ignores: ['apps/worker/src/billing/providers/polar/**', 'apps/worker/test/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@polar-sh/*'],
              message: 'Only apps/worker/src/billing/providers/polar may use the Polar SDK.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/worker/src/billing/providers/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/billing/ledger.js',
                '**/billing/purchases.js',
                '**/payments/apply.js',
                '**/pool/*',
                '../../ledger.js',
                '../../purchases.js',
                '../ledger.js',
                '../purchases.js',
              ],
              message:
                'Payment adapters translate; the domain (billing/payments/apply.ts) decides.',
            },
          ],
        },
      ],
    },
  },
);
