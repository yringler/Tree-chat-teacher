import { describe, expect, it } from 'vitest';
import { plainText, type SharePayload, type ShareScope } from '@tangent/shared';
import { projectShare, type ProjectShareInput } from '../src/share-projection.js';
import { ID_MARK, MODEL_MARK, PROVIDER_MARK, TreeBuilder } from './tree-fixture.js';

const NOW = '2026-09-29T12:00:00.000Z';
const PRIVATE_MARK = 'SECRETZQX';

/**
 * trunk "Trunk": t0(user) t1(asst) t2(user) t3(asst) + system node ts first
 *   t1 ─ Side (anchor "the quote"): s0 s1
 *          s0 ─ Deep: d0 d1
 *          s1 ─ Hidden (private): h0 ── HiddenChild: hc0
 *   t1 ─ Early (off t1, before target t2 in subtree tests): e0
 *   t3 ─ Late: l0 l1(streaming) l2(error)
 *          l1 ─ OffStreaming: o0   (fork node filtered → omitted)
 *   ts ─ OffSystem: y0             (fork node filtered → omitted)
 */
function fixture() {
  const t = new TreeBuilder('Trunk');
  const trunk = t.trunk;
  const ts = t.add(trunk, 'system', 'SYSTEMZQX prompt');
  const [t0, t1] = t.exchange(trunk, '# Hello *world*\n\nHow do `trees` work?', 'Like this.');
  const [t2, t3] = t.exchange(trunk, 'Second question', 'Second answer');
  const side = t.branch(t1, {
    title: 'Side',
    anchorQuote: 'the quote',
    createdAt: '2026-01-03T00:00:00.000Z',
  });
  const early = t.branch(t1, { title: 'Early', createdAt: '2026-01-04T00:00:00.000Z' });
  const late = t.branch(t3, { title: 'Late' });
  const offSystem = t.branch(ts, { title: 'OffSystem' });
  const [s0, s1] = t.exchange(side, 'Side question', 'Side answer');
  const deep = t.branch(s0, { title: 'Deep' });
  const [d0, d1] = t.exchange(deep, 'Deep question', 'Deep answer');
  const hidden = t.branch(s1, {
    title: `Hidden ${PRIVATE_MARK}`,
    isPrivate: true,
    anchorQuote: PRIVATE_MARK,
  });
  const h0 = t.add(hidden, 'user', `${PRIVATE_MARK} private question`);
  const hiddenChild = t.branch(h0, { title: `HiddenChild ${PRIVATE_MARK}` });
  const hc0 = t.add(hiddenChild, 'user', `${PRIVATE_MARK} private child`);
  const e0 = t.add(early, 'user', 'Early question');
  const l0 = t.add(late, 'user', 'Late question');
  const l1 = t.add(late, 'assistant', 'STREAMINGZQX partial', { status: 'streaming' });
  const l2 = t.add(late, 'assistant', 'ERRORZQX failed', { status: 'error' });
  const offStreaming = t.branch(l1, { title: 'OffStreaming' });
  const o0 = t.add(offStreaming, 'user', 'Off streaming question');
  const y0 = t.add(offSystem, 'user', 'Off system question');
  return {
    t,
    ...{ trunk, side, early, late, deep, hidden, hiddenChild, offStreaming, offSystem },
    ...{ ts, t0, t1, t2, t3, s0, s1, d0, d1, h0, hc0, e0, l0, l1, l2, o0, y0 },
  };
}

type Fixture = ReturnType<typeof fixture>;

function input(
  f: Fixture,
  scope: ShareScope,
  overrides: Partial<ProjectShareInput> = {},
): ProjectShareInput {
  return {
    tree: { title: 'My Tree' },
    branches: f.t.branches,
    nodes: f.t.nodes,
    scope,
    targetNodeId: null,
    includeAncestors: false,
    title: null,
    now: NOW,
    ...overrides,
  };
}

function payloadOf(
  f: Fixture,
  scope: ShareScope,
  overrides: Partial<ProjectShareInput> = {},
): SharePayload {
  const r = projectShare(input(f, scope, overrides));
  if (!r.ok) throw new Error(`projection failed: ${r.reason}`);
  return r.payload;
}

const contents = (p: SharePayload, key: string): string[] =>
  p.branches.find((b) => b.key === key)?.messages.map((m) => m.content) ?? [];

describe('projectShare: tree scope', () => {
  it('includes every non-private branch depth-first with sequential keys', () => {
    const f = fixture();
    const p = payloadOf(f, 'tree');
    expect(p.v).toBe(1);
    expect(p.title).toBe('My Tree');
    expect(p.scope).toBe('tree');
    expect(p.generatedAt).toBe(NOW);
    expect(p.context).toBeNull();
    expect(p.rootBranchKey).toBe('b0');
    expect(p.branches.map((b) => [b.key, b.parentKey, b.title])).toEqual([
      ['b0', null, 'Trunk'],
      ['b1', 'b0', 'Side'],
      ['b2', 'b1', 'Deep'],
      ['b3', 'b0', 'Early'],
      ['b4', 'b0', 'Late'],
    ]);
    const allKeys = p.branches.flatMap((b) => b.messages.map((m) => m.key));
    expect(allKeys).toEqual(allKeys.map((_, i) => `m${i}`));
  });

  it('links fork messages to keys in the parent branch', () => {
    const f = fixture();
    const p = payloadOf(f, 'tree');
    const [trunk, side, deep, early, late] = p.branches;
    expect(trunk?.forkMessageKey).toBeNull();
    const t1Key = trunk?.messages[1]?.key;
    expect(trunk?.messages[1]?.content).toBe('Like this.');
    expect(side?.forkMessageKey).toBe(t1Key);
    expect(early?.forkMessageKey).toBe(t1Key);
    expect(deep?.forkMessageKey).toBe(side?.messages[0]?.key);
    expect(late?.forkMessageKey).toBe(trunk?.messages[3]?.key);
    expect(side?.anchorQuote).toBe('the quote');
  });

  it('excludes system, streaming and error nodes and branches forking from them', () => {
    const f = fixture();
    const p = payloadOf(f, 'tree');
    const json = JSON.stringify(p);
    for (const marker of [
      'SYSTEMZQX',
      'STREAMINGZQX',
      'ERRORZQX',
      'Off streaming',
      'Off system',
      'OffSystem',
    ]) {
      expect(json).not.toContain(marker);
    }
    expect(contents(p, 'b4')).toEqual(['Late question']);
    for (const b of p.branches)
      for (const m of b.messages) expect(['user', 'assistant']).toContain(m.role);
  });

  it('excludes a private branch deep in the tree together with all descendants', () => {
    const f = fixture();
    const p = payloadOf(f, 'tree');
    expect(JSON.stringify(p)).not.toContain(PRIVATE_MARK);
    expect(p.branches.map((b) => b.title)).not.toContain('Hidden');
  });

  it('includes private branches when the owner opts in', () => {
    const f = fixture();
    const p = payloadOf(f, 'tree', { includePrivate: true });
    expect(p.branches.map((b) => b.title)).toEqual([
      'Trunk',
      'Side',
      'Deep',
      `Hidden ${PRIVATE_MARK}`,
      `HiddenChild ${PRIVATE_MARK}`,
      'Early',
      'Late',
    ]);
  });

  it('rejects a private trunk', () => {
    const f = fixture();
    f.trunk.isPrivate = true;
    expect(projectShare(input(f, 'tree'))).toEqual({ ok: false, reason: 'target_private' });
  });

  it('uses the explicit title when given', () => {
    const f = fixture();
    expect(payloadOf(f, 'tree', { title: 'Custom' }).title).toBe('Custom');
  });

  it('describes the share with the first user message as plain text', () => {
    const f = fixture();
    expect(payloadOf(f, 'tree').description).toBe('Hello world How do trees work?');
  });

  it('reports empty when nothing is shareable', () => {
    const t = new TreeBuilder();
    t.add(t.trunk, 'system', 'only system');
    t.add(t.trunk, 'user', 'in flight', { status: 'streaming' });
    const r = projectShare({
      tree: { title: 'X' },
      branches: t.branches,
      nodes: t.nodes,
      scope: 'tree',
      targetNodeId: null,
      includeAncestors: false,
      title: null,
      now: NOW,
    });
    expect(r).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('projectShare: subtree scope', () => {
  it('roots at the target and includes branches off included nodes only', () => {
    const f = fixture();
    const p = payloadOf(f, 'subtree', { targetNodeId: f.t2.id });
    expect(p.title).toBe('My Tree');
    // Side/Early hang off t1, before the target → excluded.
    expect(p.branches.map((b) => b.title)).toEqual(['Trunk', 'Late']);
    expect(contents(p, 'b0')).toEqual(['Second question', 'Second answer']);
    expect(p.branches[1]?.forkMessageKey).toBe('m1');
    expect(p.context).toBeNull();
    expect(p.description).toBe('Second question');
  });

  it('uses the target branch for titles and keeps the anchor quote only from seq 0', () => {
    const f = fixture();
    const fromStart = payloadOf(f, 'subtree', { targetNodeId: f.s0.id });
    expect(fromStart.title).toBe('My Tree — Side');
    expect(fromStart.branches[0]?.title).toBe('Side');
    expect(fromStart.branches[0]?.anchorQuote).toBe('the quote');
    expect(fromStart.branches[0]?.forkMessageKey).toBeNull();
    expect(fromStart.branches[0]?.parentKey).toBeNull();
    expect(fromStart.branches.map((b) => b.title)).toEqual(['Side', 'Deep']);

    const fromMiddle = payloadOf(f, 'subtree', { targetNodeId: f.s1.id });
    expect(fromMiddle.branches[0]?.anchorQuote).toBeNull();
    // Deep hangs off s0 (before target) → excluded; Hidden is private.
    expect(fromMiddle.branches.map((b) => b.title)).toEqual(['Side']);
  });

  it('puts root → target parent in context with includeAncestors', () => {
    const f = fixture();
    const p = payloadOf(f, 'subtree', { targetNodeId: f.d0.id, includeAncestors: true });
    expect(p.context?.map((m) => m.content)).toEqual([
      '# Hello *world*\n\nHow do `trees` work?',
      'Like this.',
      'Side question',
    ]);
    expect(p.context?.map((m) => m.key)).toEqual(['m0', 'm1', 'm2']);
    expect(contents(p, 'b0')).toEqual(['Deep question', 'Deep answer']);
    expect(p.branches[0]?.messages[0]?.key).toBe('m3');
    // Description ignores context.
    expect(p.description).toBe('Deep question');
    expect(JSON.stringify(p)).not.toContain('SYSTEMZQX');
  });

  it('context is null when includeAncestors is false or nothing precedes the target', () => {
    const f = fixture();
    expect(payloadOf(f, 'subtree', { targetNodeId: f.d0.id }).context).toBeNull();
    expect(
      payloadOf(f, 'subtree', { targetNodeId: f.t0.id, includeAncestors: true }).context,
    ).toBeNull();
  });

  it('rejects private and unknown targets', () => {
    const f = fixture();
    expect(projectShare(input(f, 'subtree', { targetNodeId: f.h0.id }))).toEqual({
      ok: false,
      reason: 'target_private',
    });
    expect(projectShare(input(f, 'subtree', { targetNodeId: f.hc0.id }))).toEqual({
      ok: false,
      reason: 'target_private',
    });
    expect(projectShare(input(f, 'subtree', { targetNodeId: 'missing' }))).toEqual({
      ok: false,
      reason: 'target_not_found',
    });
    expect(projectShare(input(f, 'subtree', { targetNodeId: null }))).toEqual({
      ok: false,
      reason: 'target_not_found',
    });
  });

  it('allows a private target for owner exports', () => {
    const f = fixture();
    const p = payloadOf(f, 'subtree', { targetNodeId: f.h0.id, includePrivate: true });
    expect(p.branches.map((b) => b.title)).toEqual([
      `Hidden ${PRIVATE_MARK}`,
      `HiddenChild ${PRIVATE_MARK}`,
    ]);
  });

  it('reports empty when the subtree has no shareable messages', () => {
    const f = fixture();
    expect(projectShare(input(f, 'subtree', { targetNodeId: f.l2.id }))).toEqual({
      ok: false,
      reason: 'empty',
    });
  });
});

describe('projectShare: path scope', () => {
  it('produces one branch holding root → target', () => {
    const f = fixture();
    const p = payloadOf(f, 'path', { targetNodeId: f.d1.id, includeAncestors: true });
    expect(p.title).toBe('My Tree — Deep');
    expect(p.context).toBeNull();
    expect(p.branches).toHaveLength(1);
    expect(p.branches[0]).toMatchObject({
      key: 'b0',
      parentKey: null,
      forkMessageKey: null,
      title: 'Deep',
    });
    expect(contents(p, 'b0')).toEqual([
      '# Hello *world*\n\nHow do `trees` work?',
      'Like this.',
      'Side question',
      'Deep question',
      'Deep answer',
    ]);
  });

  it('drops filtered nodes on the path', () => {
    const f = fixture();
    const p = payloadOf(f, 'path', { targetNodeId: f.l2.id });
    expect(contents(p, 'b0')).toEqual([
      '# Hello *world*\n\nHow do `trees` work?',
      'Like this.',
      'Second question',
      'Second answer',
      'Late question',
    ]);
  });

  it('rejects a private target', () => {
    const f = fixture();
    expect(projectShare(input(f, 'path', { targetNodeId: f.hc0.id }))).toEqual({
      ok: false,
      reason: 'target_private',
    });
  });
});

describe('projectShare: no leakage', () => {
  const cases: [string, (f: Fixture) => Partial<ProjectShareInput> & { scope: ShareScope }][] = [
    ['tree', () => ({ scope: 'tree' })],
    ['subtree', (f) => ({ scope: 'subtree', targetNodeId: f.s0.id, includeAncestors: true })],
    ['subtree (trunk)', (f) => ({ scope: 'subtree', targetNodeId: f.t0.id })],
    ['path', (f) => ({ scope: 'path', targetNodeId: f.d1.id })],
  ];
  for (const [name, make] of cases) {
    it(`leaks no ids, providers, models, usage or private content (${name})`, () => {
      const f = fixture();
      const o = make(f);
      const p = payloadOf(f, o.scope, o);
      const json = JSON.stringify(p);
      for (const marker of [
        ID_MARK,
        PROVIDER_MARK,
        MODEL_MARK,
        PRIVATE_MARK,
        'SYSTEMZQX',
        '987654',
        '876543',
      ]) {
        expect(json).not.toContain(marker);
      }
      for (const field of [
        'usage',
        'providerId',
        'model',
        'contextMode',
        'isPrivate',
        'seq',
        'status',
        'createdAt',
      ]) {
        expect(json).not.toContain(`"${field}"`);
      }
      // Only allow-listed fields.
      expect(Object.keys(p).sort()).toEqual(
        [
          'branches',
          'context',
          'description',
          'generatedAt',
          'rootBranchKey',
          'scope',
          'title',
          'v',
        ].sort(),
      );
      for (const b of p.branches) {
        expect(Object.keys(b).sort()).toEqual(
          ['anchorQuote', 'forkMessageKey', 'key', 'messages', 'parentKey', 'title'].sort(),
        );
        for (const m of b.messages)
          expect(Object.keys(m).sort()).toEqual(['content', 'key', 'role']);
      }
    });
  }
});

describe('the share description (plainText)', () => {
  it('strips markdown syntax and collapses whitespace', () => {
    const md =
      '## Title\n\n> quoted **bold** _em_ and `code`\n\n- item [link](https://x.y) ![img](a.png)\n\n```ts\nconst snake_case = 1;\n```';
    expect(plainText(md, { max: 200 })).toBe(
      'Title quoted bold em and code item link img const snake_case = 1;',
    );
  });

  it('truncates to max chars with an ellipsis', () => {
    const out = plainText('word '.repeat(100), { max: 200 });
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith('…')).toBe(true);
    expect(plainText('short', { max: 200 })).toBe('short');
  });

  it('description is capped at 200 chars', () => {
    const t = new TreeBuilder();
    t.add(t.trunk, 'user', 'x'.repeat(500));
    const r = projectShare({
      tree: { title: 'X' },
      branches: t.branches,
      nodes: t.nodes,
      scope: 'tree',
      targetNodeId: null,
      includeAncestors: false,
      title: null,
      now: NOW,
    });
    expect(r.ok && r.payload.description.length).toBe(200);
  });
});
describe('projectShare: sources', () => {
  it('carries a grounded reply’s sources (URL and title only), and none for others', () => {
    const t = new TreeBuilder('Trunk');
    const [, reply] = t.exchange(
      t.trunk,
      'Who invented it?',
      'Someone [example.org](https://example.org/a).',
    );
    reply.sources = [{ url: 'https://example.org/a', title: 'A', excerpt: 'not shared' }];
    const [, plain] = t.exchange(t.trunk, 'And then?', 'Then more.');
    plain.sources = [];
    const r = projectShare({
      tree: { title: 'T' },
      branches: t.branches,
      nodes: t.nodes,
      scope: 'tree',
      targetNodeId: null,
      includeAncestors: false,
      title: null,
      now: NOW,
    });
    if (!r.ok) throw new Error(r.reason);
    const messages = r.payload.branches[0]!.messages;
    expect(messages[1]!.sources).toEqual([{ url: 'https://example.org/a', title: 'A' }]);
    expect(messages[3]).not.toHaveProperty('sources');
    expect(messages[0]).not.toHaveProperty('sources');
  });
});
