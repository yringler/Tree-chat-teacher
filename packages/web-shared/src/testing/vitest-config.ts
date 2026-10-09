import { fileURLToPath } from 'node:url';
import { defineConfig, type ViteUserConfig } from 'vitest/config';
import { coverage } from '../../../../vitest.coverage.js';
import { angularJit } from './angular-jit.js';

/**
 * The vitest config of every Angular package. `*.spec.ts` run in Node (plain
 * logic: stores, helpers); `*.dom.spec.ts` render components with TestBed in
 * happy-dom, zoneless like the apps, and can't reach the network.
 */
export function angularVitestConfig(): ViteUserConfig {
  const base = coverage();
  return defineConfig({
    test: {
      coverage: { ...base, exclude: [...(base.exclude ?? []), 'src/testing/**'] },
      projects: [
        {
          extends: true,
          test: {
            name: 'node',
            environment: 'node',
            include: ['src/**/*.spec.ts'],
            exclude: ['src/**/*.dom.spec.ts'],
          },
        },
        {
          extends: true,
          plugins: [angularJit()],
          test: {
            name: 'dom',
            environment: 'happy-dom',
            environmentOptions: {
              happyDOM: {
                url: 'http://localhost/',
                settings: {
                  disableJavaScriptFileLoading: true,
                  disableCSSFileLoading: true,
                  disableIframePageLoading: true,
                },
              },
            },
            include: ['src/**/*.dom.spec.ts'],
            setupFiles: [fileURLToPath(new URL('./setup-dom.ts', import.meta.url))],
          },
        },
      ],
    },
  });
}
