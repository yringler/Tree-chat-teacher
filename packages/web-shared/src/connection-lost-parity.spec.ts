import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHECK_AGAIN_DELAY_MS,
  CHECK_AGAIN_MAX_DELAY_MS,
  CONNECTION_LOST_TEXT,
} from './conversation/conversation-store';

/*
 * A reply given up on reads the same and is checked on the same schedule in
 * the web apps (ConversationStore) and in Flutter
 * (apps/flutter/lib/state/reply_follower.dart), which can't import ours.
 */

const ROOT = new URL('../../../', import.meta.url);
const DART = 'apps/flutter/lib/state/reply_follower.dart';

describe('a reply given up on, in Flutter', () => {
  const dart = readFileSync(new URL(DART, ROOT), 'utf8');

  it('says the same in place of its end', () => {
    expect(dart).toContain(`'${CONNECTION_LOST_TEXT}'`);
  });

  it('is checked after the same first wait, and at most the same wait apart', () => {
    expect(dart).toContain(
      `checkAgainDelay = Duration(seconds: ${String(CHECK_AGAIN_DELAY_MS / 1000)});`,
    );
    expect(dart).toContain(
      `checkAgainMaxDelay = Duration(minutes: ${String(CHECK_AGAIN_MAX_DELAY_MS / 60_000)});`,
    );
  });
});
