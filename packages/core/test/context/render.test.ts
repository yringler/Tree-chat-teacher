import type { ContextPlan, ContextSegment, SummaryRequest } from '@tangent/shared';
import { describe as suite, expect, it } from 'vitest';
import { summaryKeyString } from '../../src/context/assemble.js';
import {
  ANCHOR_HEADING,
  buildSummaryPrompt,
  buildTitlePrompt,
  cleanTitle,
  CONTINUATION_MESSAGE,
  renderPlan,
  SUMMARY_HEADING,
  plainText,
} from '../../src/context/render.js';
import { Fixture, resolveAll } from './fixtures.js';

const WITH_SYSTEM = { supportsSystemPrompt: true };
const NO_SYSTEM = { supportsSystemPrompt: false };

let counter = 0;
const base = { explanation: '', sourceNodeIds: [], viaBranchId: null, tokens: 1 };
const sys = (text: string): ContextSegment => ({
  ...base,
  id: `s${counter++}`,
  kind: 'system',
  reason: 'tree-system-prompt',
  text,
});
const msg = (
  kind: 'ancestor' | 'branch',
  role: 'user' | 'assistant',
  text: string,
): ContextSegment =>
  kind === 'ancestor'
    ? { ...base, id: `s${counter++}`, kind, reason: 'path-ancestor', role, nodeId: text, text }
    : { ...base, id: `s${counter++}`, kind, reason: 'branch-message', role, nodeId: text, text };
const summary = (status: 'ready' | 'pending' | 'failed', text: string | null): ContextSegment => ({
  ...base,
  id: `s${counter++}`,
  kind: 'summary',
  reason: 'branch-summary',
  purpose: 'branch',
  key: { anchorNodeId: 'n', sourceHash: 'h' },
  status,
  text,
});
const anchor = (text: string): ContextSegment => ({
  ...base,
  id: `s${counter++}`,
  kind: 'anchor',
  reason: 'anchor-quote',
  text,
});

function plan(segments: ContextSegment[]): ContextPlan {
  return {
    treeId: 't',
    targetBranchId: 'b',
    targetNodeId: null,
    mode: 'path',
    chain: [],
    segments,
    budget: { maxInputTokens: 1000, usedTokens: 0 },
    compaction: null,
    truncation: null,
    pendingSummaries: [],
    complete: true,
  };
}

suite('renderPlan', () => {
  it('renders an empty plan', () => {
    expect(renderPlan(plan([]), WITH_SYSTEM)).toEqual({ system: null, messages: [] });
  });

  it('puts system segments in the system text and messages in order', () => {
    const out = renderPlan(
      plan([
        sys('SP'),
        msg('ancestor', 'user', 'q1'),
        msg('ancestor', 'assistant', 'a1'),
        msg('branch', 'user', 'q2'),
      ]),
      WITH_SYSTEM,
    );
    expect(out).toEqual({
      system: 'SP',
      messages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
      ],
    });
  });

  it('merges consecutive same-role messages', () => {
    const out = renderPlan(
      plan([
        msg('ancestor', 'user', 'a'),
        msg('branch', 'user', 'b'),
        msg('branch', 'assistant', 'c'),
        msg('branch', 'assistant', 'd'),
      ]),
      WITH_SYSTEM,
    );
    expect(out.messages).toEqual([
      { role: 'user', content: 'a\n\nb' },
      { role: 'assistant', content: 'c\n\nd' },
    ]);
  });

  it('prepends a synthetic user message before a leading assistant message', () => {
    const out = renderPlan(
      plan([msg('branch', 'assistant', 'hello'), msg('branch', 'user', 'hi')]),
      WITH_SYSTEM,
    );
    expect(out.messages).toEqual([
      { role: 'user', content: CONTINUATION_MESSAGE },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'hi' },
    ]);
    expect(CONTINUATION_MESSAGE).toBe('(Conversation continues.)');
  });

  it('renders ready summaries and anchors into the system text in segment order', () => {
    const out = renderPlan(
      plan([
        sys('SP'),
        summary('ready', 'Earlier: X.'),
        anchor('the quote'),
        sys('node rule'),
        msg('branch', 'user', 'go'),
      ]),
      WITH_SYSTEM,
    );
    expect(out.system).toBe(
      `SP\n\n${SUMMARY_HEADING}\n\nEarlier: X.\n\n${ANCHOR_HEADING}\n\nthe quote\n\nnode rule`,
    );
    expect(SUMMARY_HEADING).toBe('## Summary of the earlier conversation');
    expect(ANCHOR_HEADING).toBe('## The user branched off to focus on this excerpt');
    expect(out.messages).toEqual([{ role: 'user', content: 'go' }]);
  });

  it('omits pending and failed summaries', () => {
    const out = renderPlan(
      plan([summary('pending', null), summary('failed', null), msg('branch', 'user', 'go')]),
      WITH_SYSTEM,
    );
    expect(out.system).toBeNull();
    expect(out.messages).toEqual([{ role: 'user', content: 'go' }]);
  });

  it('keeps alternation when summaries/anchors sit between messages', () => {
    const out = renderPlan(
      plan([
        msg('ancestor', 'user', 'u1'),
        msg('ancestor', 'assistant', 'a1'),
        anchor('q'),
        msg('branch', 'user', 'u2'),
      ]),
      WITH_SYSTEM,
    );
    expect(out.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('skips empty message segments', () => {
    const out = renderPlan(
      plan([
        msg('branch', 'user', 'a'),
        msg('branch', 'assistant', '  '),
        msg('branch', 'user', 'b'),
      ]),
      WITH_SYSTEM,
    );
    expect(out.messages).toEqual([{ role: 'user', content: 'a\n\nb' }]);
  });

  it('folds the system text into the first user message without system prompt support', () => {
    const out = renderPlan(plan([sys('SP'), anchor('q'), msg('branch', 'user', 'hi')]), NO_SYSTEM);
    expect(out.system).toBeNull();
    expect(out.messages).toEqual([{ role: 'user', content: `SP\n\n${ANCHOR_HEADING}\n\nq\n\nhi` }]);
  });

  it('folds into the synthetic user message when the plan starts with an assistant message', () => {
    const out = renderPlan(
      plan([sys('SP'), msg('ancestor', 'assistant', 'a1'), msg('branch', 'user', 'u')]),
      NO_SYSTEM,
    );
    expect(out.messages[0]).toEqual({ role: 'user', content: `SP\n\n${CONTINUATION_MESSAGE}` });
    expect(out.messages).toHaveLength(3);
  });

  it('folds into a new user message when there are no messages', () => {
    expect(renderPlan(plan([sys('SP')]), NO_SYSTEM)).toEqual({
      system: null,
      messages: [{ role: 'user', content: 'SP' }],
    });
  });

  it('leaves messages untouched without system text when folding', () => {
    const out = renderPlan(plan([msg('branch', 'user', 'hi')]), NO_SYSTEM);
    expect(out).toEqual({ system: null, messages: [{ role: 'user', content: 'hi' }] });
  });

  it('renders an assembled summary-mode plan end to end', () => {
    const f = new Fixture();
    f.systemPrompt = 'SP';
    f.messages('T', 2);
    const b = f.fork('T.1', 'summary', { anchor: 'focus here' });
    f.messages(b, 2);
    const { plan: resolved } = resolveAll(f.input(b));
    const out = renderPlan(resolved, WITH_SYSTEM);
    expect(out.system).toBe(
      `SP\n\n${SUMMARY_HEADING}\n\nsummary@T.1\n\n${ANCHOR_HEADING}\n\nfocus here`,
    );
    expect(out.messages).toEqual([
      { role: 'user', content: 'B1.0' },
      { role: 'assistant', content: 'B1.1' },
    ]);
  });

  it('renders a failed summary plan without the summary', () => {
    const f = new Fixture();
    f.messages('T', 2);
    const b = f.fork('T.1', 'summary');
    f.messages(b, 1);
    const key = f.plan(b).pendingSummaries[0]!.key;
    const failed = f.plan(b, { failedSummaries: new Set([summaryKeyString(key)]) });
    expect(renderPlan(failed, WITH_SYSTEM)).toEqual({
      system: null,
      messages: [{ role: 'user', content: 'B1.0' }],
    });
  });
});

suite('buildSummaryPrompt', () => {
  const request: SummaryRequest = {
    key: { anchorNodeId: 'n', sourceHash: 'h' },
    purpose: 'branch',
    sourceNodeIds: ['a', 'b'],
    transcript: [
      { role: 'user', content: 'How do I sort?' },
      { role: 'assistant', content: 'Use `Array.prototype.sort`.' },
    ],
    focus: null,
  };

  it('serializes the transcript as User/Assistant blocks', () => {
    const out = buildSummaryPrompt(request);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]!.role).toBe('user');
    expect(out.messages[0]!.content).toContain(
      'User: How do I sort?\n\nAssistant: Use `Array.prototype.sort`.',
    );
    expect(out.messages[0]!.content).not.toContain('excerpt');
  });

  it('instructs a faithful, concise summary', () => {
    const out = buildSummaryPrompt(request);
    expect(out.system).toMatch(/faithful/);
    expect(out.system).toMatch(/300 words/);
    expect(out.system).toMatch(/code identifiers/);
    expect(out.system).toMatch(/new thread/);
    expect(out.messages[0]!.content.trim().endsWith('new thread.')).toBe(true);
  });

  it('mentions the focus excerpt when given', () => {
    const out = buildSummaryPrompt({ ...request, focus: 'sort stability' });
    expect(out.messages[0]!.content).toContain('sort stability');
    expect(out.system).toMatch(/excerpt/);
  });
});

suite('buildTitlePrompt', () => {
  it('asks for a short title for the given messages', () => {
    const out = buildTitlePrompt([
      { role: 'user', content: 'Tell me about tides' },
      { role: 'assistant', content: 'Tides are caused by the moon.' },
    ]);
    expect(out.system).toMatch(/2–6 words/);
    const content = out.messages[0]!.content;
    expect(content).toContain('User: Tell me about tides');
    expect(content).toContain('Assistant: Tides are caused by the moon.');
    expect(content).toMatch(/Output only the title/);
    expect(content).toMatch(/quotes/);
  });

  it('clips very long messages', () => {
    const out = buildTitlePrompt([{ role: 'user', content: 'a'.repeat(10_000) }]);
    expect(out.messages[0]!.content.length).toBeLessThan(3000);
  });
});

suite('cleanTitle', () => {
  it.each([
    ['Plain title', 'Plain title'],
    ['"Quoted Title"', 'Quoted Title'],
    ['“Curly quotes”', 'Curly quotes'],
    ["'Single'", 'Single'],
    ['# Heading Title', 'Heading Title'],
    ['**Bold Title**', 'Bold Title'],
    ['`Code` title', 'Code title'],
    ['_Emphasis Title_', 'Emphasis Title'],
    ['Title: Moon and tides', 'Moon and tides'],
    ['**Title:** "Moon and tides."', 'Moon and tides'],
    ['Ends with period.', 'Ends with period'],
    ['Question?!', 'Question'],
    ['  spaced    out\ttitle  ', 'spaced out title'],
    ['\n\n  \nSecond line wins\nthird', 'Second line wins'],
    ['**Title:**\nActual Title', 'Actual Title'],
    ["Bob's snake_case helper", "Bob's snake_case helper"],
  ])('%j → %j', (raw, expected) => {
    expect(cleanTitle(raw)).toBe(expected);
  });

  it('returns null for empty or punctuation-only input', () => {
    expect(cleanTitle('')).toBeNull();
    expect(cleanTitle('   \n  ')).toBeNull();
    expect(cleanTitle('"..."')).toBeNull();
    expect(cleanTitle('**')).toBeNull();
  });

  it('truncates to 80 chars at a word boundary', () => {
    const raw = 'word '.repeat(30);
    const out = cleanTitle(raw)!;
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith('word')).toBe(true);
    expect(out).toBe(Array(16).fill('word').join(' '));
  });

  it('hard-cuts a single overlong word', () => {
    expect(cleanTitle('x'.repeat(200))).toBe('x'.repeat(80));
  });

  it('keeps an exactly 80-char title', () => {
    const t = 'a'.repeat(80);
    expect(cleanTitle(t)).toBe(t);
  });
});

suite('plainText', () => {
  it('drops Markdown markup and collapses whitespace', () => {
    expect(
      plainText(
        "Good question! Let's start with **a confident kitten**.\n\n## Habits\n\n- **Listening**: an `owl` hums\n1. _second_ item\n> quoted [link](https://x.test) ![alt](i.png)\n\n```js\ncode();\n```\nend",
      ),
    ).toBe(
      "Good question! Let's start with a confident kitten. Habits Listening: an owl hums second item quoted link alt end",
    );
  });

  it('keeps underscores inside identifiers', () => {
    expect(plainText('use snake_case names, _not_ emphasis')).toBe(
      'use snake_case names, not emphasis',
    );
  });
});
