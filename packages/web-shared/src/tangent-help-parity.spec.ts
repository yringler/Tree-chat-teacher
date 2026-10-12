import { readFileSync } from 'node:fs';
import {
  DEFAULT_BRANCH_TITLE_PREFIX,
  HELP_ANALOGY,
  HELP_DEFAULT,
  HELP_ITEMS,
  HELP_REPLAY,
  HELP_RULE,
  HELP_SHORTCUTS,
  HELP_TEST,
  HELP_TITLE,
  KEEP_GOING_LABEL,
  MAIN_THREAD_BACK,
  MAIN_THREAD_LABEL,
  REPLY_ACTION,
  TANGENT_ACTION,
  TANGENTS_LABEL,
  WALKTHROUGH_BUTTONS,
  WALKTHROUGH_STEPS,
} from '@tangent/shared';
import { describe, expect, it } from 'vitest';

/*
 * The Flutter app can't import @tangent/shared, so it keeps a copy of the
 * tangent help words (packages/shared/src/tangent-help.ts) and the labels of
 * a reply's two suggestion groups (tangents.ts). This checks the copy has
 * every string verbatim. A new export of tangent-help.ts goes in COPY too. It also checks the default tangent title prefix, which Flutter
 * strips from titles as Learn web does.
 */

const ROOT = new URL('../../../', import.meta.url);
const DART = 'apps/flutter/lib/ui/tangent_help_copy.dart';
const OUTLINE = 'apps/flutter/lib/ui/lesson_outline.dart';

const COPY = {
  HELP_ANALOGY,
  HELP_DEFAULT,
  HELP_ITEMS,
  HELP_REPLAY,
  HELP_RULE,
  HELP_SHORTCUTS,
  HELP_TEST,
  HELP_TITLE,
  KEEP_GOING_LABEL,
  MAIN_THREAD_BACK,
  MAIN_THREAD_LABEL,
  REPLY_ACTION,
  TANGENT_ACTION,
  TANGENTS_LABEL,
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

describe('default tangent title prefix in Flutter', () => {
  it('is the same string as DEFAULT_BRANCH_TITLE_PREFIX', () => {
    const dart = readFileSync(new URL(OUTLINE, ROOT), 'utf8');
    expect(dart).toContain(`defaultBranchTitlePrefix = '${DEFAULT_BRANCH_TITLE_PREFIX}';`);
  });
});
