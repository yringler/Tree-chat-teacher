// The configuration surface: config.ts is the one module that reads vars and
// secrets, wrangler.jsonc lists only this deployment's own values, and
// docs/configuration.md documents exactly the names config.ts reads.
import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- `?raw` is a Vite import; the worker tsconfig has no vite/client types.
import configurationDoc from '../../../docs/configuration.md?raw';
import { appConfig, CONFIG_SECRETS, CONFIG_VARS, TEST_VARS } from '../src/config.js';
import type { AppEnv } from '../src/env.js';
import { shippedEnv, shippedVars, stripJsonc } from './mocks/wrangler-vars.js';
// @ts-expect-error -- `?raw` is a Vite import; the worker tsconfig has no vite/client types.
import wranglerText from '../wrangler.jsonc?raw';

const env = rawEnv as unknown as AppEnv;

// @ts-expect-error -- `import.meta.glob` is Vite's; the worker tsconfig has no vite/client types.
const SOURCES = import.meta.glob('../src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

interface WranglerBindings {
  assets?: { binding?: string };
  d1_databases?: { binding: string }[];
  durable_objects?: { bindings: { name: string }[] };
  ratelimits?: { name: string }[];
}

/** The binding names wrangler.jsonc declares: what env holds besides vars and secrets. */
function bindingNames(): Set<string> {
  const c = JSON.parse(stripJsonc(wranglerText as string)) as WranglerBindings;
  return new Set([
    ...(c.assets?.binding ? [c.assets.binding] : []),
    ...(c.d1_databases ?? []).map((d) => d.binding),
    ...(c.durable_objects?.bindings ?? []).map((d) => d.name),
    ...(c.ratelimits ?? []).map((r) => r.name),
  ]);
}

describe('env reads', () => {
  it('only config.ts reads vars and secrets; every other module reads bindings alone', () => {
    const bindings = bindingNames();
    expect(bindings).toContain('DB');
    const files = Object.entries(SOURCES).filter(
      ([path]) => !path.endsWith('/src/config.ts') && !path.endsWith('/src/env.ts'),
    );
    expect(files.length).toBeGreaterThan(50);
    const offenders: string[] = [];
    for (const [path, text] of files) {
      for (const m of text.matchAll(/\benv\??\.([A-Z][A-Z0-9_]*)\b/g))
        if (!bindings.has(m[1]!)) offenders.push(`${path}: env.${m[1]}`);
      // Reads by a computed name, or of every entry.
      const dynamic =
        /\benv\s*\[|(?:Object\.(?:entries|keys|values)|Reflect\.get)\(\s*(?:c\.|this\.)?env\b|\}\s*=\s*(?:c\.|this\.)?env\b/;
      if (dynamic.test(text)) offenders.push(`${path}: reads env by a computed name`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('wrangler.jsonc', () => {
  // Polar's settings only count while its secrets are set.
  const base = () => shippedEnv(env, { POLAR_ACCESS_TOKEN: 'oat', POLAR_WEBHOOK_SECRET: 'whsec' });

  it('sets only vars config.ts reads, and no secret', () => {
    for (const name of Object.keys(shippedVars())) {
      expect(CONFIG_VARS, name).toContain(name);
      expect(CONFIG_SECRETS.has(name as (typeof CONFIG_VARS)[number]), name).toBe(false);
    }
  });

  it('sets only values that differ from the default', () => {
    const shipped = JSON.stringify(appConfig(base()));
    for (const name of Object.keys(shippedVars())) {
      const defaulted = JSON.stringify(appConfig({ ...base(), [name]: '' } as AppEnv));
      expect(defaulted, `${name} restates its default`).not.toBe(shipped);
    }
  });
});

describe('docs/configuration.md', () => {
  /** The names each reference entry (`` - `NAME`, `NAME`: … ``) starts with. */
  const documented = [
    ...(configurationDoc as string).matchAll(/^- ((?:`[A-Z][A-Z0-9_]*`(?:, )?)+):/gm),
  ]
    .flatMap((m) => [...m[1]!.matchAll(/`([A-Z][A-Z0-9_]*)`/g)])
    .map((m) => m[1]!);

  it('documents every var and secret config.ts reads, once, and nothing else', () => {
    expect([...documented].sort()).toEqual([...CONFIG_VARS].sort());
  });

  it('never documents the test-only vars', () => {
    for (const name of TEST_VARS) expect(configurationDoc as string).not.toContain(name);
  });
});
