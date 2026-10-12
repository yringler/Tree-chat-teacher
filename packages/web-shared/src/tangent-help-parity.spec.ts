import { readFileSync } from 'node:fs';
import {
  HELP_ANALOGY,
  HELP_DEFAULT,
  HELP_ITEMS,
  HELP_REPLAY,
  HELP_RULE,
  HELP_SHORTCUTS,
  HELP_TEST,
  HELP_TITLE,
  MAIN_THREAD_BACK,
  MAIN_THREAD_LABEL,
  REPLY_ACTION,
  TANGENT_ACTION,
  WALKTHROUGH_BUTTONS,
  WALKTHROUGH_STEPS,
} from '@tangent/shared';
import { describe, expect, it } from 'vitest';

/*
 * The Flutter app can't import @tangent/shared, so it keeps a copy of the
 * tangent help words (packages/shared/src/tangent-help.ts). This checks the
 * copy has every string verbatim. A new export of tangent-help.ts goes in
 * COPY too.
 */

const ROOT = new URL('../../../', import.meta.url);
const DART = 'apps/flutter/lib/ui/tangent_help_copy.dart';

const COPY = {
  HELP_ANALOGY,
  HELP_DEFAULT,
  HELP_ITEMS,
  HELP_REPLAY,
  HELP_RULE,
  HELP_SHORTCUTS,
  HELP_TEST,
  HELP_TITLE,
  MAIN_THREAD_BACK,
  MAIN_THREAD_LABEL,
  REPLY_ACTION,
  TANGENT_ACTION,
  WALKTHROUGH_BUTTONS,
  WALKTHROUGH_STEPS,
};

/** Every string inside `value`, with the path that leads to it. */
function strings(value: unknown, path: string): [string, string][] {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${path}[${i}]`));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => strings(v, `${path}.${k}`));
  }
  return [];
}

describe('tangent help copy in Flutter', () => {
  const dart = readFileSync(new URL(DART, ROOT), 'utf8');
  const all = strings(COPY, 'copy');

  it('finds strings to check', () => {
    expect(all.length).toBeGreaterThan(15);
  });

  it.each(all)('%s is in the Dart mirror verbatim', (_path, text) => {
    expect(dart).toContain(`'${text.replaceAll("'", "\\'")}'`);
  });
});
