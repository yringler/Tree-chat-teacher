import { readFileSync } from 'node:fs';
import {
  LEARN_REPLY_FIXED_MODEL_NOTE,
  LEARN_REPLY_LENGTHS,
  LEARN_REPLY_LONG_WARNING,
  LEARN_REPLY_MAX_REQUIRED_NOTE,
  LEARN_REPLY_POOL_NOTE,
  LEARN_REPLY_WARNING_MARK,
  LENGTH_REQUIRES_MAX,
  LEARN_TIER_HINTS,
  REPLY_LENGTH_FOOTNOTE,
  REPLY_LENGTH_HINTS,
  REPLY_LENGTH_LABELS,
  TIER_LABELS,
} from '@tangent/shared';
import { describe, expect, it } from 'vitest';

/*
 * The Flutter app can't import @tangent/shared, so it keeps a copy of the
 * Advanced settings' words and rules (packages/shared/src/learn-reply.ts)
 * in apps/flutter/lib/state/learn_reply.dart. This checks the copy has
 * every string verbatim, which lengths require Max, and the pieces the
 * composer chip is built from;
 * learn_reply_test.dart there checks the chip's cases as learn-reply.spec.ts
 * does here. The prompt each length sends is the server's alone.
 */

const ROOT = new URL('../../../', import.meta.url);
const DART = 'apps/flutter/lib/state/learn_reply.dart';

const COPY = {
  TIER_LABELS,
  LEARN_TIER_HINTS,
  REPLY_LENGTH_LABELS,
  REPLY_LENGTH_HINTS,
  REPLY_LENGTH_FOOTNOTE,
  LEARN_REPLY_POOL_NOTE,
  LEARN_REPLY_FIXED_MODEL_NOTE,
  LEARN_REPLY_MAX_REQUIRED_NOTE,
  LEARN_REPLY_WARNING_MARK,
  LEARN_REPLY_LONG_WARNING,
};

/** Every string inside `value`, with the path that leads to it. */
function strings(value: unknown, path: string): [string, string][] {
  if (typeof value === 'string') return [[path, value]];
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => strings(v, `${path}.${k}`));
  }
  return [];
}

describe('Advanced settings copy in Flutter', () => {
  const dart = readFileSync(new URL(DART, ROOT), 'utf8');
  const all = strings(COPY, 'copy');

  it('finds strings to check', () => {
    expect(all.length).toBeGreaterThan(10);
  });

  it.each(all)('%s is in the Dart mirror verbatim', (_path, text) => {
    expect(dart).toContain(`'${text.replaceAll("'", "\\'")}'`);
  });

  it.each(LEARN_REPLY_LENGTHS)('says whether %s requires Max, as LENGTH_REQUIRES_MAX does', (l) => {
    expect(dart).toContain(`ReplyLength.${l}: ${String(LENGTH_REQUIRES_MAX[l])},`);
  });

  it('builds the chip from the same pieces', () => {
    // As written in learnReplyIndicator: the label's joiner, and the spoken label's words.
    for (const piece of [
      "' · '",
      "'Max model'",
      "'Max model (required for ",
      " replies'",
      "'Advanced settings: ",
      " Change'",
    ]) {
      expect(dart).toContain(piece);
    }
  });
});
