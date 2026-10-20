import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * The shared stylesheets' custom properties. An undefined token makes its
 * declaration invalid at computed-value time, so the property quietly falls
 * back to its inherited or initial value. A `var()` with a fallback is a hook
 * an app may set (`--gutter`, `--chat-rem`); one without names a token these
 * files define.
 */

const DIR = new URL('./', import.meta.url);
const css = readdirSync(DIR)
  .filter((name) => name.endsWith('.css'))
  .map((name) => readFileSync(new URL(name, DIR), 'utf8'))
  .join('\n');

describe('shared stylesheet tokens', () => {
  it('every var() without a fallback names a token the shared stylesheets define', () => {
    const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    const used = [...css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((m) => m[1]);
    expect([...new Set(used.filter((name) => !defined.has(name)))]).toEqual([]);
  });
});
