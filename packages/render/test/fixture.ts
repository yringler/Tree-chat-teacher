import type { SharePayload } from '@tangent/shared';

/**
 * b0 Trunk: m2 m3 m4 m5
 *   m3 ─ b1 Side (anchor) : m6 m7
 *          m6 ─ b2 Deep : m8
 *   m3 ─ b3 Other : (empty)
 *   m5 ─ b4 Late : m9
 * context: m0 m1
 */
export function samplePayload(overrides: Partial<SharePayload> = {}): SharePayload {
  return {
    v: 1,
    title: 'Trees & "Branches" <script>alert(1)</script>',
    description: 'How do <trees> work? "quoted" & more',
    scope: 'subtree',
    generatedAt: '2026-09-29T12:00:00.000Z',
    context: [
      { key: 'm0', role: 'user', content: 'CONTEXTQ earlier question' },
      { key: 'm1', role: 'assistant', content: 'CONTEXTA earlier answer' },
    ],
    rootBranchKey: 'b0',
    branches: [
      {
        key: 'b0',
        parentKey: null,
        forkMessageKey: null,
        title: 'Trunk',
        anchorQuote: null,
        messages: [
          { key: 'm2', role: 'user', content: '# CONTENTQ1 How do *trees* work?' },
          {
            key: 'm3',
            role: 'assistant',
            content: 'CONTENTA1 Like this:\n\n```ts\nconst x: number = 1;\n```',
          },
          { key: 'm4', role: 'user', content: 'CONTENTQ2 <script>alert("x")</script>' },
          { key: 'm5', role: 'assistant', content: 'CONTENTA2 [link](https://example.com)' },
        ],
      },
      {
        key: 'b1',
        parentKey: 'b0',
        forkMessageKey: 'm3',
        title: 'Side <b>topic</b>',
        anchorQuote: 'ANCHORQ the "quote" <i>',
        messages: [
          { key: 'm6', role: 'user', content: 'CONTENTQ3 side question' },
          { key: 'm7', role: 'assistant', content: 'CONTENTA3 side answer' },
        ],
      },
      {
        key: 'b2',
        parentKey: 'b1',
        forkMessageKey: 'm6',
        title: 'Deep',
        anchorQuote: null,
        messages: [{ key: 'm8', role: 'user', content: 'CONTENTQ4 deep' }],
      },
      {
        key: 'b3',
        parentKey: 'b0',
        forkMessageKey: 'm3',
        title: 'Other',
        anchorQuote: null,
        messages: [],
      },
      {
        key: 'b4',
        parentKey: 'b0',
        forkMessageKey: 'm5',
        title: 'Late',
        anchorQuote: null,
        messages: [{ key: 'm9', role: 'assistant', content: 'CONTENTA5 late' }],
      },
    ],
    ...overrides,
  };
}

export const CONTENT_MARKERS = [
  'CONTEXTQ',
  'CONTEXTA',
  'CONTENTQ1',
  'CONTENTA1',
  'CONTENTQ2',
  'CONTENTA2',
  'CONTENTQ3',
  'CONTENTA3',
  'CONTENTQ4',
  'CONTENTA5',
  'ANCHORQ',
];
