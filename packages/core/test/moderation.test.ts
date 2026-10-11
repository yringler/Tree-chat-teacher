import type { SharePayload } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import {
  MODERATION_BATCH_SIZE,
  MODERATION_CATEGORIES,
  MODERATION_MAX_CHARS,
  MODERATION_PIECE_CHARS,
  moderateTexts,
  verdictOf,
  type CategoryScores,
  type ModerationCategory,
  type ModerationProvider,
} from '../src/moderation/moderation.js';
import { shareTexts } from '../src/moderation/share-texts.js';

function scores(set: Partial<Record<ModerationCategory, number>> = {}): CategoryScores {
  return {
    ...Object.fromEntries(MODERATION_CATEGORIES.map((c) => [c, 0])),
    ...set,
  } as CategoryScores;
}

/** Scores each input from markers in it, and keeps every batch it was asked. */
class MarkerProvider implements ModerationProvider {
  readonly batches: string[][] = [];
  classify(inputs: readonly string[]): Promise<readonly CategoryScores[]> {
    this.batches.push([...inputs]);
    return Promise.resolve(
      inputs.map((t) =>
        scores({
          violence: t.includes('VIOLENT') ? 0.9 : 0.01,
          'sexual/minors': t.includes('MINOR') ? 0.2 : 0,
          harassment: t.includes('RUDE') ? 0.7 : 0,
        }),
      ),
    );
  }
}

describe('verdictOf', () => {
  it('flags sexual/minors at a low score before anything else', () => {
    expect(verdictOf(scores({ 'sexual/minors': 0.1, violence: 1 })).kind).toBe('csam_flag');
    expect(verdictOf(scores({ 'sexual/minors': 0.09 })).kind).toBe('allow');
  });

  it('blocks at the thresholds and names the categories; allows the rest', () => {
    expect(
      verdictOf(scores({ violence: 0.8, 'harassment/threatening': 0.6, 'illicit/violent': 0.49 })),
    ).toMatchObject({ kind: 'block', reasons: ['harassment/threatening', 'violence'] });
    expect(verdictOf(scores({ violence: 0.79, harassment: 1, sexual: 1 })).kind).toBe('allow');
  });
});

describe('moderateTexts', () => {
  it('takes the highest score of each category across every input', async () => {
    const verdict = await moderateTexts(new MarkerProvider(), ['RUDE', 'VIOLENT', 'calm']);
    expect(verdict).toMatchObject({
      kind: 'block',
      reasons: ['violence'],
      maxScores: { violence: 0.9, harassment: 0.7 },
    });
    expect((await moderateTexts(new MarkerProvider(), ['a MINOR thing'])).kind).toBe('csam_flag');
    expect(await moderateTexts(new MarkerProvider(), ['calm'])).toMatchObject({ kind: 'allow' });
  });

  it('splits long texts into pieces and batches them, skipping blank ones', async () => {
    const provider = new MarkerProvider();
    const long = 'x'.repeat(MODERATION_PIECE_CHARS) + 'VIOLENT';
    const many = Array.from({ length: MODERATION_BATCH_SIZE }, (_, i) => `m${i}`);
    const verdict = await moderateTexts(provider, [long, ' ', ...many]);
    expect(verdict.kind).toBe('block');
    expect(provider.batches.map((b) => b.length)).toEqual([MODERATION_BATCH_SIZE, 2]);
    expect(provider.batches[0]![1]).toBe('VIOLENT');
  });

  it('allows nothing to screen without asking', async () => {
    const provider = new MarkerProvider();
    expect((await moderateTexts(provider, ['', '  '])).kind).toBe('allow');
    expect(provider.batches).toEqual([]);
  });

  it('refuses more text than one publish screens, without asking', async () => {
    const provider = new MarkerProvider();
    const verdict = await moderateTexts(provider, ['x'.repeat(MODERATION_MAX_CHARS), 'y']);
    expect(verdict).toEqual({ kind: 'too_long' });
    expect(provider.batches).toEqual([]);
  });

  it('turns a failure or a short answer into an error verdict', async () => {
    const failing: ModerationProvider = { classify: () => Promise.reject(new Error('HTTP 500')) };
    expect(await moderateTexts(failing, ['a'])).toEqual({ kind: 'error', message: 'HTTP 500' });
    const short: ModerationProvider = { classify: () => Promise.resolve([]) };
    expect((await moderateTexts(short, ['a'])).kind).toBe('error');
  });
});

describe('shareTexts', () => {
  it("lists the title, context, branch titles, anchors, both sides' messages and source titles", () => {
    const payload: SharePayload = {
      v: 1,
      title: 'T',
      description: 'D-NOT-SHOWN',
      scope: 'subtree',
      generatedAt: '2026-01-01T00:00:00Z',
      context: [{ key: 'c', role: 'user', content: 'C' }],
      rootBranchKey: 'b',
      branches: [
        {
          key: 'b',
          parentKey: null,
          forkMessageKey: null,
          title: 'B',
          anchorQuote: 'Q',
          messages: [
            { key: 'u', role: 'user', content: 'U' },
            {
              key: 'a',
              role: 'assistant',
              content: 'A',
              sources: [
                { url: 'https://a.example', title: 'S' },
                { url: 'https://b.example', title: null },
              ],
            },
          ],
        },
      ],
    };
    expect(shareTexts(payload)).toEqual(['T', 'C', 'B', 'Q', 'U', 'A', 'S']);
  });
});
