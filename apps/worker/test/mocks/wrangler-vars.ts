// The `vars` wrangler.jsonc deploys with, parsed from the file itself, so a
// test can run on the shipped configuration instead of the test env's
// (vitest.config.ts overrides many of them).
// @ts-expect-error -- `?raw` is a Vite import; the worker tsconfig has no vite/client types.
import wranglerText from '../../wrangler.jsonc?raw';
import { CONFIG_SECRETS, CONFIG_VARS } from '../../src/config.js';
import type { AppEnv } from '../../src/env.js';

/** Calls `outside` for every character of `text` that is not inside a JSON string. */
function scan(text: string, outside: (i: number) => { skipTo: number } | null): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inString = false;
      continue;
    }
    const skip = outside(i);
    if (skip) {
      i = skip.skipTo - 1;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

/** `text` without its comments and trailing commas (JSONC → JSON). */
export function stripJsonc(text: string): string {
  const uncommented = scan(text, (i) => {
    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      return { skipTo: end === -1 ? text.length : end };
    }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      return { skipTo: end === -1 ? text.length : end + 2 };
    }
    return null;
  });
  const closes = /\s*[}\]]/y;
  return scan(uncommented, (i) => {
    if (uncommented[i] !== ',') return null;
    closes.lastIndex = i + 1;
    return closes.test(uncommented) ? { skipTo: i + 1 } : null;
  });
}

/** wrangler.jsonc's top-level `vars`. */
export function shippedVars(): Record<string, string> {
  const config = JSON.parse(stripJsonc(wranglerText as string)) as { vars?: unknown };
  const vars = config.vars;
  if (typeof vars !== 'object' || vars === null) throw new Error('wrangler.jsonc has no vars');
  return Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, String(v)]));
}

/**
 * `env` as wrangler.jsonc deploys it: its vars, and every other var empty
 * (its default). The test env's secrets, local-dev vars and test vars stay,
 * and `overrides` go on top.
 */
export function shippedEnv(env: AppEnv, overrides: Partial<AppEnv> = {}): AppEnv {
  const defaulted = CONFIG_VARS.filter(
    (name) => !CONFIG_SECRETS.has(name) && !name.startsWith('DEV_'),
  );
  return {
    ...env,
    ...Object.fromEntries(defaulted.map((name) => [name, ''])),
    ...shippedVars(),
    ...overrides,
  } as AppEnv;
}
