import type { ChatMessage, ContextMode, ContextPlan, ContextSegment } from '@tangent/shared';
import { describe as suite, expect, it } from 'vitest';
import { assembleContext, summaryKeyString } from '../../src/context/assemble.js';
import type { AssembleBudget } from '../../src/context/assemble.js';
import { renderPlan } from '../../src/context/render.js';
import { ValidationError } from '../../src/errors.js';
import { sha256Hex } from '../../src/hash.js';
import { estimateTokens, MESSAGE_OVERHEAD_TOKENS } from '../../src/tokens.js';
import { charTokens, describe, Fixture, resolveAll, summarySegments } from './fixtures.js';

const MODES: ContextMode[] = ['path', 'summary', 'message', 'independent'];

const u = (content: string): ChatMessage => ({ role: 'user', content });
const a = (content: string): ChatMessage => ({ role: 'assistant', content });

function expectedHash(transcript: ChatMessage[], focus: string | null): string {
  return sha256Hex(JSON.stringify({ transcript, focus }));
}

function seg(plan: ContextPlan, description: string): ContextSegment {
  const found = plan.segments.find((s) => describe({ ...plan, segments: [s] })[0] === description);
  if (!found) throw new Error(`no segment ${description} in ${describe(plan).join(' | ')}`);
  return found;
}

/** Provenance invariants that hold for every plan built from a Fixture. */
function checkProvenance(f: Fixture, plan: ContextPlan): void {
  plan.segments.forEach((s, idx) => {
    expect(s.id).toBe(`seg-${idx}`);
    switch (s.kind) {
      case 'ancestor': {
        const node = f.node(s.nodeId);
        if (s.reason === 'branch-point-message') {
          // Sent because some branch on the chain forks from it in message mode.
          const forks = plan.chain.filter((c) => c.branchPointNodeId === s.nodeId);
          expect(forks.map((c) => c.mode)).toContain('message');
        } else {
          expect(s.reason).toBe('path-ancestor');
        }
        expect(s.viaBranchId).toBe(node.branchId);
        expect(s.viaBranchId).not.toBe(plan.targetBranchId);
        expect(s.sourceNodeIds).toEqual([s.nodeId]);
        expect(s.role).toBe(node.role);
        expect(s.explanation).toContain(f.branch(node.branchId).title);
        break;
      }
      case 'branch':
        expect(s.reason).toBe('branch-message');
        expect(s.viaBranchId).toBe(plan.targetBranchId);
        expect(f.node(s.nodeId).branchId).toBe(plan.targetBranchId);
        expect(s.sourceNodeIds).toEqual([s.nodeId]);
        break;
      case 'anchor': {
        const branch = f.branch(s.viaBranchId!);
        expect(s.reason).toBe('anchor-quote');
        expect(s.text).toBe(branch.anchorQuote);
        expect(s.sourceNodeIds).toEqual([branch.branchPointNodeId]);
        break;
      }
      case 'summary':
        if (s.purpose === 'branch') {
          expect(s.reason).toBe('branch-summary');
          expect(f.branch(s.viaBranchId!).contextMode).toBe('summary');
          expect(s.key.anchorNodeId).toBe(f.branch(s.viaBranchId!).branchPointNodeId);
        } else {
          expect(s.reason).toBe('budget-compaction');
          expect(s.viaBranchId).toBe(plan.targetBranchId);
        }
        break;
      case 'system':
        expect(['tree-system-prompt', 'system-node']).toContain(s.reason);
        break;
    }
  });
}

// ---------------------------------------------------------------------------

suite('trunk only', () => {
  it('sends every trunk message as a branch segment', () => {
    const f = new Fixture();
    f.messages('T', 4);
    const plan = f.plan('T');
    expect(describe(plan)).toEqual(['br:T.0', 'br:T.1', 'br:T.2', 'br:T.3']);
    expect(plan.segments.map((s) => s.id)).toEqual(['seg-0', 'seg-1', 'seg-2', 'seg-3']);
    expect(plan.targetBranchId).toBe('T');
    expect(plan.targetNodeId).toBe('T.3');
    expect(plan.mode).toBe('path');
    expect(plan.chain).toEqual([
      { branchId: 'T', title: 'Trunk', mode: 'path', branchPointNodeId: null },
    ]);
    expect(plan.complete).toBe(true);
    expect(plan.pendingSummaries).toEqual([]);
    expect(plan.compaction).toBeNull();
    expect(plan.truncation).toBeNull();
    expect(plan.treeId).toBe('tree-1');
    checkProvenance(f, plan);
  });

  it('puts the tree system prompt first', () => {
    const f = new Fixture();
    f.systemPrompt = 'Be terse.';
    f.messages('T', 2);
    const plan = f.plan('T');
    expect(describe(plan)).toEqual(['sys:Be terse.', 'br:T.0', 'br:T.1']);
    const sys = plan.segments[0]!;
    expect(sys.reason).toBe('tree-system-prompt');
    expect(sys.viaBranchId).toBeNull();
    expect(sys.sourceNodeIds).toEqual([]);
  });

  it('omits a blank tree system prompt', () => {
    const f = new Fixture();
    f.systemPrompt = '   ';
    f.messages('T', 1);
    expect(describe(f.plan('T'))).toEqual(['br:T.0']);
  });

  it('handles an empty trunk', () => {
    const f = new Fixture();
    const plan = f.plan('T');
    expect(plan.segments).toEqual([]);
    expect(plan.targetNodeId).toBeNull();
    expect(plan.budget.usedTokens).toBe(0);
    expect(plan.complete).toBe(true);
  });
});

suite('each mode directly under the trunk', () => {
  function build(mode: ContextMode, anchor: string | null = 'quote') {
    const f = new Fixture();
    f.messages('T', 4);
    const b = f.fork('T.1', mode, { anchor, title: 'Child' });
    f.messages(b, 2);
    return { f, b };
  }

  it('path inherits the trunk up to the branch point, then anchor, then own messages', () => {
    const { f, b } = build('path');
    const plan = f.plan(b);
    expect(describe(plan)).toEqual(['anc:T.0', 'anc:T.1', 'quote:quote', 'br:B1.0', 'br:B1.1']);
    expect(plan.mode).toBe('path');
    expect(plan.chain.map((c) => c.branchId)).toEqual(['T', 'B1']);
    expect(plan.chain[1]).toEqual({
      branchId: 'B1',
      title: 'Child',
      mode: 'path',
      branchPointNodeId: 'T.1',
    });
    expect(seg(plan, 'anc:T.0').explanation).toBe('Inherited from ‘Trunk’ via path mode');
    checkProvenance(f, plan);
  });

  it('summary emits a pending branch summary with a request', () => {
    const { f, b } = build('summary');
    const plan = f.plan(b);
    expect(describe(plan)).toEqual(['sum:branch:pending', 'quote:quote', 'br:B1.0', 'br:B1.1']);
    expect(plan.complete).toBe(false);
    const [sum] = summarySegments(plan);
    const transcript = [u('T.0'), a('T.1')];
    expect(sum!.key).toEqual({
      anchorNodeId: 'T.1',
      sourceHash: expectedHash(transcript, 'quote'),
    });
    expect(sum!.text).toBeNull();
    expect(sum!.tokens).toBe(0);
    expect(sum!.viaBranchId).toBe('B1');
    expect(sum!.sourceNodeIds).toEqual(['T.0', 'T.1']);
    expect(plan.pendingSummaries).toEqual([
      {
        key: sum!.key,
        purpose: 'branch',
        sourceNodeIds: ['T.0', 'T.1'],
        transcript,
        focus: 'quote',
      },
    ]);
    checkProvenance(f, plan);
  });

  it('summary uses a ready summary text', () => {
    const { f, b } = build('summary');
    const first = f.plan(b);
    const key = first.pendingSummaries[0]!.key;
    const plan = f.plan(b, {
      summaries: new Map([[summaryKeyString(key), 'The trunk talked about X.']]),
    });
    expect(describe(plan)).toEqual(['sum:branch:ready', 'quote:quote', 'br:B1.0', 'br:B1.1']);
    const [sum] = summarySegments(plan);
    expect(sum!.text).toBe('The trunk talked about X.');
    expect(sum!.status).toBe('ready');
    expect(sum!.tokens).toBe(estimateTokens('The trunk talked about X.'));
    expect(plan.complete).toBe(true);
    expect(plan.pendingSummaries).toEqual([]);
  });

  it('message sends the branch-point message, then the anchor and own messages', () => {
    const { f, b } = build('message');
    const plan = f.plan(b);
    expect(describe(plan)).toEqual(['anc:T.1', 'quote:quote', 'br:B1.0', 'br:B1.1']);
    expect(plan.mode).toBe('message');
    expect(plan.complete).toBe(true);
    const point = seg(plan, 'anc:T.1');
    expect(point.reason).toBe('branch-point-message');
    expect(point.viaBranchId).toBe('T');
    expect(point.explanation).toBe(
      'The message in ‘Trunk’ that ‘Child’ branched from, because it uses parent-message mode',
    );
    checkProvenance(f, plan);
  });

  it('message without an anchor sends the branch-point message and own messages', () => {
    const { f, b } = build('message', null);
    f.systemPrompt = 'SP';
    expect(describe(f.plan(b))).toEqual(['sys:SP', 'anc:T.1', 'br:B1.0', 'br:B1.1']);
  });

  it('message off a user message sends that user message', () => {
    const f = new Fixture();
    f.messages('T', 4);
    const b = f.fork('T.2', 'message', { anchor: 'q' });
    f.add(b, 'assistant');
    const plan = f.plan(b);
    expect(describe(plan)).toEqual(['anc:T.2', 'quote:q', 'br:B1.0']);
    checkProvenance(f, plan);
  });

  it('message off a failed reply with no content sends only the anchor', () => {
    const f = new Fixture();
    f.messages('T', 1);
    f.add('T', 'assistant', '', { status: 'error' });
    const b = f.fork('T.1', 'message', { anchor: 'q' });
    f.messages(b, 1);
    expect(describe(f.plan(b))).toEqual(['quote:q', 'br:B1.0']);
  });

  it('independent sends only the anchor and own messages', () => {
    const { f, b } = build('independent');
    const plan = f.plan(b);
    expect(describe(plan)).toEqual(['quote:quote', 'br:B1.0', 'br:B1.1']);
    expect(plan.mode).toBe('independent');
    expect(plan.complete).toBe(true);
    checkProvenance(f, plan);
  });

  it('independent without an anchor sends only own messages (plus the tree system prompt)', () => {
    const { f, b } = build('independent', null);
    f.systemPrompt = 'SP';
    expect(describe(f.plan(b))).toEqual(['sys:SP', 'br:B1.0', 'br:B1.1']);
  });

  it.each(MODES)('%s mode still sends the tree system prompt first', (mode) => {
    const { f, b } = build(mode);
    f.systemPrompt = 'SP';
    const plan = f.plan(b);
    expect(describe(plan)[0]).toBe('sys:SP');
    expect(plan.segments[0]!.reason).toBe('tree-system-prompt');
  });
});

suite('two-level nesting (3×3)', () => {
  /**
   * T: T.0 u, T.1 a, T.2 u, T.3 a
   * B1 (m1, anchor q1) off T.1: B1.0 u, B1.1 a, B1.2 u
   * B2 (m2, anchor q2) off B1.1: B2.0 u
   * plus decoys: a sibling of B1, a sibling of B2 and a child of B2's sibling.
   */
  function build(m1: ContextMode, m2: ContextMode) {
    const f = new Fixture();
    f.messages('T', 4);
    f.fork('T.1', m1, { id: 'B1', anchor: 'q1', title: 'One' });
    f.messages('B1', 3);
    f.fork('B1.1', m2, { id: 'B2', anchor: 'q2', title: 'Two' });
    f.messages('B2', 1);
    f.fork('T.1', 'path', { id: 'X1' });
    f.add('X1', 'user', 'SECRET sibling of B1');
    f.fork('B1.1', 'path', { id: 'X2' });
    f.add('X2', 'user', 'SECRET sibling of B2');
    f.fork('X2.0', 'path', { id: 'X3' });
    f.add('X3', 'user', 'SECRET nephew');
    return f;
  }

  const ctx1: Record<ContextMode, string[]> = {
    path: ['anc:T.0', 'anc:T.1', 'quote:q1', 'anc:B1.0', 'anc:B1.1'],
    summary: ['sum:branch:ready', 'quote:q1', 'anc:B1.0', 'anc:B1.1'],
    message: ['anc:T.1', 'quote:q1', 'anc:B1.0', 'anc:B1.1'],
    independent: ['quote:q1', 'anc:B1.0', 'anc:B1.1'],
  };
  const flat1: Record<ContextMode, ChatMessage[]> = {
    path: [u('T.0'), a('T.1'), u('[Focus excerpt] q1'), u('B1.0'), a('B1.1')],
    summary: [
      u('[Summary of earlier conversation] summary@T.1'),
      u('[Focus excerpt] q1'),
      u('B1.0'),
      a('B1.1'),
    ],
    message: [a('T.1'), u('[Focus excerpt] q1'), u('B1.0'), a('B1.1')],
    independent: [u('[Focus excerpt] q1'), u('B1.0'), a('B1.1')],
  };
  const sources1: Record<ContextMode, string[]> = {
    path: ['T.0', 'T.1', 'B1.0', 'B1.1'],
    summary: ['T.0', 'T.1', 'B1.0', 'B1.1'],
    message: ['T.1', 'B1.0', 'B1.1'],
    independent: ['T.1', 'B1.0', 'B1.1'],
  };

  const cases = MODES.flatMap((m1) => MODES.map((m2) => [m1, m2] as const));

  it.each(cases)('%s → %s', (m1, m2) => {
    const f = build(m1, m2);
    const { plan, requests } = resolveAll(f.input('B2'));

    const own = ['quote:q2', 'br:B2.0'];
    const prefix: Record<ContextMode, string[]> = {
      path: ctx1[m1],
      summary: ['sum:branch:ready'],
      message: ['anc:B1.1'],
      independent: [],
    };
    const expected = [...prefix[m2], ...own];
    expect(describe(plan)).toEqual(expected);
    expect(plan.mode).toBe(m2);
    expect(plan.chain.map((c) => [c.branchId, c.mode])).toEqual([
      ['T', 'path'],
      ['B1', m1],
      ['B2', m2],
    ]);
    expect(plan.complete).toBe(true);
    expect(JSON.stringify(plan)).not.toContain('SECRET');
    expect(JSON.stringify(requests)).not.toContain('SECRET');
    expect(JSON.stringify(plan)).not.toContain('T.2');
    expect(JSON.stringify(plan)).not.toContain('B1.2');
    checkProvenance(f, plan);

    const b2Summary = requests.find((r) => r.key.anchorNodeId === 'B1.1');
    const b1Summary = requests.find((r) => r.key.anchorNodeId === 'T.1');
    if (m2 === 'summary') {
      expect(b2Summary).toBeDefined();
      expect(b2Summary!.transcript).toEqual(flat1[m1]);
      expect(b2Summary!.focus).toBe('q2');
      expect(b2Summary!.sourceNodeIds).toEqual(sources1[m1]);
      const [sum] = summarySegments(plan);
      expect(sum!.viaBranchId).toBe('B2');
      expect(sum!.sourceNodeIds).toEqual(sources1[m1]);
      expect(sum!.text).toBe('summary@B1.1');
      expect(sum!.key.sourceHash).toBe(expectedHash(flat1[m1], 'q2'));
    } else {
      expect(b2Summary).toBeUndefined();
    }
    // The inner (B1) summary is only needed when B2 actually sees B1's context.
    const needsInner = m1 === 'summary' && (m2 === 'path' || m2 === 'summary');
    expect(b1Summary !== undefined).toBe(needsInner);
    if (b1Summary) {
      expect(b1Summary.transcript).toEqual([u('T.0'), a('T.1')]);
      expect(b1Summary.focus).toBe('q1');
    }
    // Inner summaries are always requested before the outer ones.
    if (needsInner && m2 === 'summary') {
      expect(requests.map((r) => r.key.anchorNodeId)).toEqual(['T.1', 'B1.1']);
    }
  });
});

suite('three-level chains', () => {
  function chain3(m1: ContextMode, m2: ContextMode, m3: ContextMode) {
    const f = new Fixture();
    f.messages('T', 2);
    f.fork('T.1', m1, { id: 'B1', anchor: 'q1' });
    f.messages('B1', 2);
    f.fork('B1.1', m2, { id: 'B2', anchor: 'q2' });
    f.messages('B2', 2);
    f.fork('B2.1', m3, { id: 'B3', anchor: 'q3' });
    f.messages('B3', 1);
    return f;
  }

  it('path → path → path concatenates everything', () => {
    const f = chain3('path', 'path', 'path');
    const plan = f.plan('B3');
    expect(describe(plan)).toEqual([
      'anc:T.0',
      'anc:T.1',
      'quote:q1',
      'anc:B1.0',
      'anc:B1.1',
      'quote:q2',
      'anc:B2.0',
      'anc:B2.1',
      'quote:q3',
      'br:B3.0',
    ]);
    checkProvenance(f, plan);
  });

  it('summary → path → path keeps the trunk summarized (path does not re-expand)', () => {
    const f = chain3('summary', 'path', 'path');
    const { plan } = resolveAll(f.input('B3'));
    expect(describe(plan)).toEqual([
      'sum:branch:ready',
      'quote:q1',
      'anc:B1.0',
      'anc:B1.1',
      'quote:q2',
      'anc:B2.0',
      'anc:B2.1',
      'quote:q3',
      'br:B3.0',
    ]);
    expect(summarySegments(plan)[0]!.viaBranchId).toBe('B1');
    checkProvenance(f, plan);
  });

  it('independent → path → path never shows the trunk', () => {
    const f = chain3('independent', 'path', 'path');
    const plan = f.plan('B3');
    expect(describe(plan)).toEqual([
      'quote:q1',
      'anc:B1.0',
      'anc:B1.1',
      'quote:q2',
      'anc:B2.0',
      'anc:B2.1',
      'quote:q3',
      'br:B3.0',
    ]);
  });

  it('independent → path → summary summarizes the narrowed context', () => {
    const f = chain3('independent', 'path', 'summary');
    const { plan, requests } = resolveAll(f.input('B3'));
    expect(describe(plan)).toEqual(['sum:branch:ready', 'quote:q3', 'br:B3.0']);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.transcript).toEqual([
      u('[Focus excerpt] q1'),
      u('B1.0'),
      a('B1.1'),
      u('[Focus excerpt] q2'),
      u('B2.0'),
      a('B2.1'),
    ]);
  });

  it('summary → summary → summary resolves inner-first in 3 generation rounds', () => {
    const f = chain3('summary', 'summary', 'summary');
    const { plan, requests, rounds } = resolveAll(f.input('B3'));
    expect(requests.map((r) => r.key.anchorNodeId)).toEqual(['T.1', 'B1.1', 'B2.1']);
    expect(rounds).toBe(4);
    expect(describe(plan)).toEqual(['sum:branch:ready', 'quote:q3', 'br:B3.0']);
    expect(requests[2]!.transcript[0]).toEqual(u('[Summary of earlier conversation] summary@B1.1'));
  });

  it('message → path → path keeps only the trunk branch-point message', () => {
    const f = chain3('message', 'path', 'path');
    const plan = f.plan('B3');
    expect(describe(plan)).toEqual([
      'anc:T.1',
      'quote:q1',
      'anc:B1.0',
      'anc:B1.1',
      'quote:q2',
      'anc:B2.0',
      'anc:B2.1',
      'quote:q3',
      'br:B3.0',
    ]);
    expect(seg(plan, 'anc:T.1').reason).toBe('branch-point-message');
    expect(seg(plan, 'anc:B1.0').reason).toBe('path-ancestor');
    checkProvenance(f, plan);
  });

  it('summary → message → path drops the inner summary', () => {
    const f = chain3('summary', 'message', 'path');
    const { plan, requests } = resolveAll(f.input('B3'));
    expect(describe(plan)).toEqual([
      'anc:B1.1',
      'quote:q2',
      'anc:B2.0',
      'anc:B2.1',
      'quote:q3',
      'br:B3.0',
    ]);
    expect(requests).toEqual([]);
    checkProvenance(f, plan);
  });

  it('path → independent → path starts at the independent branch', () => {
    const f = chain3('path', 'independent', 'path');
    expect(describe(f.plan('B3'))).toEqual([
      'quote:q2',
      'anc:B2.0',
      'anc:B2.1',
      'quote:q3',
      'br:B3.0',
    ]);
  });
});

suite('targets', () => {
  it('an empty path branch sends the inherited context and anchor, with targetNodeId null', () => {
    const f = new Fixture();
    f.messages('T', 3);
    const b = f.fork('T.1', 'path', { anchor: 'hi' });
    const plan = f.plan(b);
    expect(describe(plan)).toEqual(['anc:T.0', 'anc:T.1', 'quote:hi']);
    expect(plan.targetNodeId).toBeNull();
  });

  it('an empty independent branch without anchor sends nothing', () => {
    const f = new Fixture();
    f.messages('T', 2);
    const b = f.fork('T.1', 'independent');
    const plan = f.plan(b);
    expect(plan.segments).toEqual([]);
    expect(plan.targetNodeId).toBeNull();
  });

  it('a mid-trunk target stops at that node', () => {
    const f = new Fixture();
    f.messages('T', 5);
    const plan = f.plan('T', { targetNodeId: 'T.2' });
    expect(describe(plan)).toEqual(['br:T.0', 'br:T.1', 'br:T.2']);
    expect(plan.targetNodeId).toBe('T.2');
  });

  it('a mid-branch target in a child branch stops at that node', () => {
    const f = new Fixture();
    f.messages('T', 2);
    const b = f.fork('T.1', 'path');
    f.messages(b, 4);
    const plan = f.plan(b, { targetNodeId: 'B1.1' });
    expect(describe(plan)).toEqual(['anc:T.0', 'anc:T.1', 'br:B1.0', 'br:B1.1']);
    expect(plan.targetNodeId).toBe('B1.1');
  });

  it('an explicit leaf target equals the null target', () => {
    const f = new Fixture();
    f.messages('T', 3);
    expect(f.plan('T', { targetNodeId: 'T.2' })).toEqual(f.plan('T'));
  });

  it('ignores extra nodes and branches not on the path', () => {
    const f = new Fixture();
    f.messages('T', 2);
    const b = f.fork('T.0', 'path');
    f.add(b, 'user', 'SECRET child');
    const other = f.fork('B1.0', 'summary');
    f.add(other, 'user', 'SECRET grandchild');
    const plan = f.plan('T');
    expect(describe(plan)).toEqual(['br:T.0', 'br:T.1']);
    expect(plan.chain).toHaveLength(1);
  });
});

suite('isolation', () => {
  function tree() {
    const f = new Fixture();
    f.messages('T', 4);
    const a1 = f.fork('T.1', 'path', { id: 'A' });
    f.messages(a1, 2);
    const s1 = f.fork('T.1', 'path', { id: 'S' });
    f.add(s1, 'user', 'SECRET sibling');
    f.add(s1, 'assistant', 'SECRET sibling reply');
    const s2 = f.fork('S.1', 'summary', { id: 'SS', anchor: 'SECRET anchor' });
    f.add(s2, 'user', 'SECRET sibling descendant');
    const a2 = f.fork('A.1', 'path', { id: 'AC' });
    f.add(a2, 'user', 'SECRET child of A');
    return f;
  }

  it.each(MODES)('siblings and their descendants never appear (%s)', (mode) => {
    const f = tree();
    f.branch('A').contextMode = mode;
    const { plan, requests } = resolveAll(f.input('A'));
    expect(JSON.stringify(plan)).not.toContain('SECRET');
    expect(JSON.stringify(requests)).not.toContain('SECRET');
  });

  it('the trunk never sees its children', () => {
    const f = tree();
    const plan = f.plan('T');
    expect(describe(plan)).toEqual(['br:T.0', 'br:T.1', 'br:T.2', 'br:T.3']);
    expect(JSON.stringify(plan)).not.toContain('SECRET');
    expect(JSON.stringify(plan)).not.toContain('A.0');
  });

  it('a child never sees trunk messages after its branch point', () => {
    const f = tree();
    const plan = f.plan('A');
    expect(describe(plan)).toEqual(['anc:T.0', 'anc:T.1', 'br:A.0', 'br:A.1']);
  });
});

suite('anchor quote', () => {
  it.each(MODES)('is placed right before the own messages in %s mode', (mode) => {
    const f = new Fixture();
    f.messages('T', 2);
    const b = f.fork('T.1', mode, { anchor: 'the excerpt', title: 'Focus' });
    f.messages(b, 1);
    const { plan } = resolveAll(f.input(b));
    const d = describe(plan);
    expect(d.slice(-2)).toEqual(['quote:the excerpt', 'br:B1.0']);
    const anchor = seg(plan, 'quote:the excerpt');
    expect(anchor.reason).toBe('anchor-quote');
    expect(anchor.viaBranchId).toBe(b);
    expect(anchor.sourceNodeIds).toEqual(['T.1']);
    expect(anchor.tokens).toBe(estimateTokens('the excerpt'));
    expect(anchor.explanation).toContain('Focus');
  });

  it('treats a whitespace-only anchor as absent', () => {
    const f = new Fixture();
    f.messages('T', 2);
    const b = f.fork('T.1', 'summary', { anchor: '  ' });
    f.messages(b, 1);
    const plan = f.plan(b);
    expect(describe(plan)).toEqual(['sum:branch:pending', 'br:B1.0']);
    expect(plan.pendingSummaries[0]!.focus).toBeNull();
  });

  it('focuses the summary and changes its hash', () => {
    const f = new Fixture();
    f.messages('T', 2);
    const b = f.fork('T.1', 'summary', { anchor: 'alpha' });
    const withAlpha = f.plan(b).pendingSummaries[0]!;
    expect(withAlpha.focus).toBe('alpha');
    expect(withAlpha.key.sourceHash).toBe(expectedHash([u('T.0'), a('T.1')], 'alpha'));
    f.branch(b).anchorQuote = 'beta';
    const withBeta = f.plan(b).pendingSummaries[0]!;
    expect(withBeta.key.sourceHash).not.toBe(withAlpha.key.sourceHash);
    f.branch(b).anchorQuote = null;
    const without = f.plan(b).pendingSummaries[0]!;
    expect(without.focus).toBeNull();
    expect(without.key.sourceHash).toBe(expectedHash([u('T.0'), a('T.1')], null));
    expect(without.key.anchorNodeId).toBe('T.1');
  });
});

suite('summary keys and caching', () => {
  function build() {
    const f = new Fixture();
    f.messages('T', 4);
    f.fork('T.1', 'path', { id: 'P' });
    f.messages('P', 2);
    f.fork('P.1', 'summary', { id: 'S', anchor: 'q' });
    f.messages('S', 2);
    return f;
  }
  const keyOf = (f: Fixture) => f.plan('S').pendingSummaries[0]!.key;

  it('formats summary keys as anchor:hash', () => {
    expect(summaryKeyString({ anchorNodeId: 'n1', sourceHash: 'abc' })).toBe('n1:abc');
  });

  it('is stable for the same input', () => {
    const f = build();
    expect(keyOf(f)).toEqual(keyOf(f));
    expect(keyOf(f)).toEqual(keyOf(build()));
  });

  it('changes when an upstream message is edited', () => {
    const f = build();
    const before = keyOf(f);
    f.node('T.0').content = 'edited';
    const after = keyOf(f);
    expect(after.anchorNodeId).toBe(before.anchorNodeId);
    expect(after.sourceHash).not.toBe(before.sourceHash);
  });

  it('changes when an ancestor mode changes', () => {
    const f = build();
    const before = keyOf(f);
    f.branch('P').contextMode = 'independent';
    expect(keyOf(f).sourceHash).not.toBe(before.sourceHash);
  });

  it('does not change when the summary branch itself grows or is edited', () => {
    const f = build();
    const before = keyOf(f);
    f.node('S.0').content = 'edited own message';
    f.messages('S', 2);
    expect(keyOf(f)).toEqual(before);
  });

  it('does not change when the parent continues after the branch point', () => {
    const f = build();
    const before = keyOf(f);
    f.messages('P', 2);
    f.messages('T', 2);
    expect(keyOf(f)).toEqual(before);
  });

  it('ignores summaries stored under a different key', () => {
    const f = build();
    const plan = f.plan('S', { summaries: new Map([['P.1:deadbeef', 'stale']]) });
    expect(summarySegments(plan)[0]!.status).toBe('pending');
  });

  it('marks failed summaries as failed without a request', () => {
    const f = build();
    const key = keyOf(f);
    const plan = f.plan('S', { failedSummaries: new Set([summaryKeyString(key)]) });
    const [sum] = summarySegments(plan);
    expect(sum!.status).toBe('failed');
    expect(sum!.text).toBeNull();
    expect(sum!.tokens).toBe(0);
    expect(sum!.key).toEqual(key);
    expect(plan.complete).toBe(false);
    expect(plan.pendingSummaries).toEqual([]);
  });

  it('prefers an available summary over a failed marker', () => {
    const f = build();
    const k = summaryKeyString(keyOf(f));
    const plan = f.plan('S', { summaries: new Map([[k, 'ok']]), failedSummaries: new Set([k]) });
    expect(summarySegments(plan)[0]!.status).toBe('ready');
    expect(plan.complete).toBe(true);
  });
});

suite('nested summaries', () => {
  function build() {
    const f = new Fixture();
    f.messages('T', 2);
    f.fork('T.1', 'summary', { id: 'S1', anchor: 'q1' });
    f.messages('S1', 2);
    f.fork('S1.1', 'summary', { id: 'S2', anchor: 'q2' });
    f.messages('S2', 1);
    return f;
  }

  it('requests the inner summary first; the outer one is pending without a request', () => {
    const f = build();
    const plan = f.plan('S2');
    expect(describe(plan)).toEqual(['sum:branch:pending', 'quote:q2', 'br:S2.0']);
    expect(plan.pendingSummaries).toHaveLength(1);
    const inner = plan.pendingSummaries[0]!;
    expect(inner.key.anchorNodeId).toBe('T.1');
    expect(inner.transcript).toEqual([u('T.0'), a('T.1')]);
    expect(inner.focus).toBe('q1');
    const outer = summarySegments(plan)[0]!;
    expect(outer.key.anchorNodeId).toBe('S1.1');
    expect(outer.viaBranchId).toBe('S2');
    expect(outer.sourceNodeIds).toEqual(['T.0', 'T.1', 'S1.0', 'S1.1']);
    expect(plan.complete).toBe(false);
  });

  it('requests the outer summary once the inner one is available', () => {
    const f = build();
    const inner = f.plan('S2').pendingSummaries[0]!;
    const summaries = new Map([[summaryKeyString(inner.key), 'INNER']]);
    const plan = f.plan('S2', { summaries });
    expect(plan.pendingSummaries).toHaveLength(1);
    const outer = plan.pendingSummaries[0]!;
    const transcript = [
      u('[Summary of earlier conversation] INNER'),
      u('[Focus excerpt] q1'),
      u('S1.0'),
      a('S1.1'),
    ];
    expect(outer.transcript).toEqual(transcript);
    expect(outer.key).toEqual({ anchorNodeId: 'S1.1', sourceHash: expectedHash(transcript, 'q2') });
    expect(outer.sourceNodeIds).toEqual(['T.0', 'T.1', 'S1.0', 'S1.1']);

    summaries.set(summaryKeyString(outer.key), 'OUTER');
    const done = f.plan('S2', { summaries });
    expect(done.complete).toBe(true);
    expect(summarySegments(done)[0]!.text).toBe('OUTER');
  });

  it('keeps the outer summary pending (no requests at all) when the inner one failed', () => {
    const f = build();
    const inner = f.plan('S2').pendingSummaries[0]!;
    const plan = f.plan('S2', { failedSummaries: new Set([summaryKeyString(inner.key)]) });
    expect(describe(plan)).toEqual(['sum:branch:pending', 'quote:q2', 'br:S2.0']);
    expect(plan.pendingSummaries).toEqual([]);
    expect(plan.complete).toBe(false);
  });

  it('a new inner summary text changes the outer hash', () => {
    const f = build();
    const inner = summaryKeyString(f.plan('S2').pendingSummaries[0]!.key);
    const h1 = f.plan('S2', { summaries: new Map([[inner, 'A']]) }).pendingSummaries[0]!.key
      .sourceHash;
    const h2 = f.plan('S2', { summaries: new Map([[inner, 'B']]) }).pendingSummaries[0]!.key
      .sourceHash;
    expect(h1).not.toBe(h2);
  });

  it('omits a branch summary when the parent context has nothing to summarize', () => {
    const f = new Fixture();
    f.add('T', 'system', 'Only instructions');
    const b = f.fork('T.0', 'summary', { anchor: 'q' });
    f.messages(b, 1);
    const plan = f.plan(b);
    expect(describe(plan)).toEqual(['quote:q', 'br:B1.0']);
    expect(plan.complete).toBe(true);
  });
});

suite('system nodes', () => {
  function build(mode: ContextMode) {
    const f = new Fixture();
    f.systemPrompt = 'SP';
    f.add('T', 'user');
    f.add('T', 'system', 'Use British spelling.');
    f.add('T', 'assistant');
    const b = f.fork('T.2', mode, { anchor: 'q' });
    f.add(b, 'user');
    return { f, b };
  }

  it('become system segments where inherited through path', () => {
    const { f, b } = build('path');
    const plan = f.plan(b);
    expect(describe(plan)).toEqual([
      'sys:SP',
      'anc:T.0',
      'sys:Use British spelling.',
      'anc:T.2',
      'quote:q',
      'br:B1.0',
    ]);
    const s = seg(plan, 'sys:Use British spelling.');
    expect(s.reason).toBe('system-node');
    expect(s.viaBranchId).toBe('T');
    expect(s.sourceNodeIds).toEqual(['T.1']);
    expect(s.tokens).toBe(estimateTokens('Use British spelling.'));
  });

  it('are never summarized', () => {
    const { f, b } = build('summary');
    const plan = f.plan(b);
    expect(describe(plan)).toEqual(['sys:SP', 'sum:branch:pending', 'quote:q', 'br:B1.0']);
    expect(plan.pendingSummaries[0]!.transcript).toEqual([u('T.0'), a('T.2')]);
    expect(plan.pendingSummaries[0]!.sourceNodeIds).toEqual(['T.0', 'T.2']);
  });

  it('are not inherited by independent branches', () => {
    const { f, b } = build('independent');
    expect(describe(f.plan(b))).toEqual(['sys:SP', 'quote:q', 'br:B1.0']);
  });

  it('in the target branch become system segments too', () => {
    const f = new Fixture();
    f.add('T', 'user');
    f.add('T', 'system', 'be brief');
    const plan = f.plan('T');
    expect(describe(plan)).toEqual(['br:T.0', 'sys:be brief']);
    expect(plan.segments[1]!.reason).toBe('system-node');
    expect(plan.targetNodeId).toBe('T.1');
  });
});

suite('streaming and error nodes', () => {
  it('skips a streaming leaf even with partial content', () => {
    const f = new Fixture();
    f.add('T', 'user');
    f.add('T', 'assistant', 'partial', { status: 'streaming' });
    const plan = f.plan('T');
    expect(describe(plan)).toEqual(['br:T.0']);
    expect(plan.targetNodeId).toBe('T.0');
  });

  it('skips error nodes with empty content but keeps ones with content', () => {
    const f = new Fixture();
    f.add('T', 'user');
    f.add('T', 'assistant', '', { status: 'error' });
    f.add('T', 'user', 'retry');
    f.add('T', 'assistant', 'half an answer', { status: 'error' });
    expect(describe(f.plan('T'))).toEqual(['br:T.0', 'br:retry', 'br:half an answer']);
  });

  it('skips failed ancestor replies and excludes them from summaries', () => {
    const f = new Fixture();
    f.add('T', 'user');
    f.add('T', 'assistant', '', { status: 'error' });
    f.add('T', 'user', 'again');
    const p = f.fork('T.2', 'path');
    const s = f.fork('T.2', 'summary');
    expect(describe(f.plan(p))).toEqual(['anc:T.0', 'anc:again']);
    expect(f.plan(s).pendingSummaries[0]!.transcript).toEqual([u('T.0'), u('again')]);
  });
});

suite('validation', () => {
  function base() {
    const f = new Fixture();
    f.messages('T', 3);
    f.fork('T.1', 'path', { id: 'B' });
    f.messages('B', 2);
    return f;
  }

  it('rejects an unknown target branch', () => {
    const f = base();
    expect(() => f.plan('nope')).toThrow(ValidationError);
  });

  it('rejects a target node from another branch', () => {
    const f = base();
    expect(() => f.plan('B', { targetNodeId: 'T.2' })).toThrow(/not in target branch/);
  });

  it('rejects an unknown target node', () => {
    const f = base();
    expect(() => f.plan('B', { targetNodeId: 'ghost' })).toThrow(ValidationError);
  });

  it('rejects a missing parent branch', () => {
    const f = base();
    const plan = () => f.plan('B', { branches: f.branches.filter((b) => b.id !== 'T') });
    expect(plan).toThrow(ValidationError);
    expect(plan).toThrow(/Parent branch T/);
  });

  it('rejects a branch point that is not in the parent branch', () => {
    const f = base();
    f.fork('B.0', 'path', { id: 'C' });
    f.add('C', 'user');
    f.branch('C').parentBranchId = 'T';
    expect(() => f.plan('C')).toThrow(/not in parent branch/);
  });

  it('rejects a missing branch point node', () => {
    const f = base();
    expect(() => f.plan('B', { nodes: f.nodes.filter((n) => n.id !== 'T.1') })).toThrow(
      ValidationError,
    );
  });

  it('rejects missing path nodes', () => {
    const f = base();
    expect(() => f.plan('B', { nodes: f.nodes.filter((n) => n.id !== 'T.0') })).toThrow(
      /missing path node/,
    );
    expect(() => f.plan('B', { nodes: f.nodes.filter((n) => n.id !== 'B.0') })).toThrow(
      /missing path node/,
    );
  });

  it('rejects a non-trunk branch without a branch point', () => {
    const f = base();
    f.branch('B').branchPointNodeId = null;
    expect(() => f.plan('B')).toThrow(ValidationError);
  });

  it('rejects a cyclic chain and branches of other trees', () => {
    const f = base();
    f.branch('T').parentBranchId = 'B';
    f.branch('T').branchPointNodeId = 'B.0';
    expect(() => f.plan('B')).toThrow(/cycle/);
    const g = base();
    g.branch('T').treeId = 'other';
    expect(() => g.plan('B')).toThrow(ValidationError);
  });

  it('uses the bad_request error code', () => {
    const f = base();
    try {
      f.plan('nope');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe('bad_request');
    }
  });
});

suite('token budget', () => {
  const X = 'x'.repeat(100); // 100 + 4 = 104 tokens per message with charTokens

  /** Trunk with `count` 100-char messages, ids T.0 … */
  function long(count: number) {
    const f = new Fixture();
    for (let i = 0; i < count; i++) f.add('T', i % 2 === 0 ? 'user' : 'assistant', X);
    return f;
  }

  it('estimates message tokens with overhead and leaves a fitting plan alone', () => {
    const f = new Fixture();
    f.systemPrompt = 'System prompt!';
    f.add('T', 'user', 'Hello there, how are you?');
    const plan = f.plan('T', { budget: { maxInputTokens: 100 } });
    const expected =
      estimateTokens('System prompt!') +
      estimateTokens('Hello there, how are you?') +
      MESSAGE_OVERHEAD_TOKENS;
    expect(plan.segments[1]!.tokens).toBe(
      estimateTokens('Hello there, how are you?') + MESSAGE_OVERHEAD_TOKENS,
    );
    expect(plan.budget).toEqual({ maxInputTokens: 100, usedTokens: expected });
    expect(plan.compaction).toBeNull();
    expect(plan.truncation).toBeNull();
  });

  it('uses an injected estimator', () => {
    const f = long(3);
    const plan = f.plan('T', { estimateTokens: charTokens });
    expect(plan.budget.usedTokens).toBe(3 * 104);
  });

  it('fits exactly at the limit without compacting', () => {
    const f = long(3);
    const plan = f.plan('T', { estimateTokens: charTokens, budget: { maxInputTokens: 312 } });
    expect(plan.compaction).toBeNull();
  });

  /** Over the budget, compacting only what this turn needs (`compactionTarget: 1`). */
  function compacted() {
    const f = long(10);
    const input = f.input('T', {
      estimateTokens: charTokens,
      budget: {
        maxInputTokens: 500,
        compactionSummaryTokens: 100,
        minTailMessages: 2,
        compactionTarget: 1,
      },
    });
    return { f, input };
  }

  it('with compactionTarget 1, compacts the shortest oldest prefix and keeps the tail and target', () => {
    const { input } = compacted();
    const plan = assembleContext(input);
    // 1040 - 7*104 + 100 = 412 <= 500; 6 messages would leave 516.
    expect(describe(plan)).toEqual(['sum:compaction:pending', `br:${X}`, `br:${X}`, `br:${X}`]);
    expect(plan.segments.slice(1).map((s) => s.sourceNodeIds[0])).toEqual(['T.7', 'T.8', 'T.9']);
    const ids = ['T.0', 'T.1', 'T.2', 'T.3', 'T.4', 'T.5', 'T.6'];
    const transcript = ids.map(
      (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: X }) as ChatMessage,
    );
    const key = { anchorNodeId: 'T.6', sourceHash: expectedHash(transcript, null) };
    expect(plan.compaction).toEqual({
      compactedNodeIds: ids,
      tokensBefore: 1040,
      tokensAfter: 312,
      key,
    });
    const [sum] = summarySegments(plan);
    expect(sum!.purpose).toBe('compaction');
    expect(sum!.reason).toBe('budget-compaction');
    expect(sum!.viaBranchId).toBe('T');
    expect(sum!.sourceNodeIds).toEqual(ids);
    expect(sum!.explanation).toContain('500');
    expect(plan.pendingSummaries).toEqual([
      { key, purpose: 'compaction', sourceNodeIds: ids, transcript, focus: null },
    ]);
    expect(plan.budget.usedTokens).toBe(312);
    expect(plan.complete).toBe(false);
    expect(plan.truncation).toBeNull();
    expect(plan.segments.map((s) => s.id)).toEqual(['seg-0', 'seg-1', 'seg-2', 'seg-3']);
  });

  it('uses a ready compaction summary with its real size', () => {
    const { input } = compacted();
    const key = assembleContext(input).compaction!.key;
    const plan = assembleContext({
      ...input,
      summaries: new Map([[summaryKeyString(key), 'short summary']]),
    });
    expect(plan.compaction!.key).toEqual(key);
    expect(describe(plan)[0]).toBe('sum:compaction:ready');
    expect(summarySegments(plan)[0]!.text).toBe('short summary');
    expect(plan.budget.usedTokens).toBe(312 + 'short summary'.length);
    expect(plan.compaction!.tokensAfter).toBe(312 + 'short summary'.length);
    expect(plan.complete).toBe(true);
    expect(plan.truncation).toBeNull();
  });

  it('truncates when the ready compaction summary is larger than estimated', () => {
    const { input } = compacted();
    const key = assembleContext(input).compaction!.key;
    const big = 'y'.repeat(300);
    const plan = assembleContext({ ...input, summaries: new Map([[summaryKeyString(key), big]]) });
    expect(plan.compaction).not.toBeNull();
    expect(plan.truncation).toEqual({
      droppedSegmentIds: ['seg-3'],
      droppedNodeIds: ['T.0', 'T.1', 'T.2', 'T.3', 'T.4', 'T.5', 'T.6'],
      tokensBefore: 612,
      tokensAfter: 312,
    });
    expect(describe(plan)).toEqual([`br:${X}`, `br:${X}`, `br:${X}`]);
    expect(plan.budget.usedTokens).toBe(312);
  });

  it('by default compacts a whole step, down to about half the budget', () => {
    const f = long(16);
    const plan = f.plan('T', {
      estimateTokens: charTokens,
      budget: { maxInputTokens: 1000, compactionSummaryTokens: 100, minTailMessages: 2 },
    });
    // 1664 is 664 over; steps of 1000 * 0.5 = 500 → 1000, plus the summary's 100: 11 messages.
    expect(plan.compaction!.compactedNodeIds).toHaveLength(11);
    expect(plan.compaction!.compactedNodeIds.at(-1)).toBe('T.10');
    // 520 + the estimated 100 for the summary: about half the budget.
    expect(plan.compaction!.tokensAfter).toBe(520);
    expect(summarySegments(plan)[0]!.explanation).toContain('500 tokens at a time');
  });

  it('compacts all the candidates when a whole step is out of reach but they fit', () => {
    const f = long(10);
    const plan = f.plan('T', {
      estimateTokens: charTokens,
      // Needs 1040 - 800 = 240 compacted, a step is 750, but the 5 candidates before
      // the 5-message tail hold only 520: all 5 go, not just the 3 that would fit.
      budget: {
        maxInputTokens: 800,
        compactionSummaryTokens: 0,
        minTailMessages: 5,
        compactionTarget: 0.0625,
      },
    });
    expect(plan.compaction!.compactedNodeIds).toEqual(['T.0', 'T.1', 'T.2', 'T.3', 'T.4']);
    expect(plan.truncation).toBeNull();
  });

  suite('over several turns', () => {
    /**
     * A trunk of `start` messages, then one user + assistant turn at a time;
     * each turn is planned with the summaries resolved so far (the cache).
     */
    function turns(start: number, count: number, budget: Partial<AssembleBudget>) {
      const f = long(start);
      const summaries = new Map<string, string>();
      const out: {
        plan: ContextPlan;
        requests: number;
        rendered: ReturnType<typeof renderPlan>;
      }[] = [];
      for (let turn = 0; turn < count; turn++) {
        if (turn > 0) {
          f.add('T', 'user', X);
          f.add('T', 'assistant', X);
        }
        const r = resolveAll(
          f.input('T', {
            estimateTokens: charTokens,
            summaries,
            budget: { maxInputTokens: 2000, compactionSummaryTokens: 100, ...budget },
          }),
        );
        for (const [k, v] of r.summaries) summaries.set(k, v);
        out.push({
          plan: r.plan,
          requests: r.requests.length,
          rendered: renderPlan(r.plan, { supportsSystemPrompt: true }),
        });
      }
      return out;
    }

    it('reuse one compaction summary and keep the sent prefix until the context grows a step', () => {
      // 20 messages = 2080, 80 over 2000: compact a step of 1000 plus the summary's 100.
      // Each turn adds 208; at the 6th turn the overflow passes a step and the boundary moves once.
      const seq = turns(20, 8, {});
      const keys = seq.map((t) => summaryKeyString(t.plan.compaction!.key));
      expect(new Set(keys.slice(0, 5)).size).toBe(1);
      expect(seq.map((t) => t.requests)).toEqual([1, 0, 0, 0, 0, 1, 0, 0]);
      expect(keys[5]).not.toBe(keys[0]);
      expect(new Set(keys.slice(5)).size).toBe(1);
      expect(seq[0]!.plan.compaction!.compactedNodeIds).toHaveLength(11);
      expect(seq[5]!.plan.compaction!.compactedNodeIds).toHaveLength(21);
      for (const t of seq) {
        expect(t.plan.complete).toBe(true);
        expect(t.plan.truncation).toBeNull();
        expect(t.plan.budget.usedTokens).toBeLessThanOrEqual(2000);
      }
      // Within a step the system prompt (with the summary) is the same and each
      // turn's messages start with the previous turn's: the cached prefix holds.
      for (const range of [
        [0, 5],
        [5, 8],
      ] as const) {
        for (let i = range[0] + 1; i < range[1]; i++) {
          const before = seq[i - 1]!.rendered;
          const now = seq[i]!.rendered;
          expect(now.system).toBe(before.system);
          expect(now.messages.slice(0, before.messages.length)).toEqual(before.messages);
        }
      }
    });

    it('with compactionTarget 1, compact one more segment (a new summary) every turn', () => {
      const seq = turns(20, 4, { compactionTarget: 1 });
      const keys = seq.map((t) => summaryKeyString(t.plan.compaction!.key));
      expect(new Set(keys).size).toBe(4);
      expect(seq.map((t) => t.requests)).toEqual([1, 1, 1, 1]);
    });
  });

  it('respects minTailMessages', () => {
    const f = long(10);
    const plan = f.plan('T', {
      estimateTokens: charTokens,
      budget: { maxInputTokens: 700, compactionSummaryTokens: 100, minTailMessages: 5 },
    });
    // 1040 - 5*104 + 100 = 620 <= 700 → 5 compacted, exactly the 5 candidates.
    expect(plan.compaction!.compactedNodeIds).toEqual(['T.0', 'T.1', 'T.2', 'T.3', 'T.4']);
    expect(plan.segments).toHaveLength(6);
  });

  it('never compacts system segments', () => {
    const f = new Fixture();
    f.systemPrompt = 'SP';
    f.add('T', 'user', X);
    f.add('T', 'system', 'rule');
    for (let i = 0; i < 6; i++) f.add('T', i % 2 === 0 ? 'assistant' : 'user', X);
    const plan = f.plan('T', {
      estimateTokens: charTokens,
      budget: { maxInputTokens: 500, compactionSummaryTokens: 50, minTailMessages: 2 },
    });
    const d = describe(plan);
    expect(d[0]).toBe('sys:SP');
    expect(d).toContain('sys:rule');
    expect(d[1]).toBe('sum:compaction:pending');
    expect(plan.compaction!.compactedNodeIds).not.toContain('T.1');
    expect(plan.pendingSummaries[0]!.transcript.every((m) => m.content === X)).toBe(true);
  });

  it('compacts inherited summaries and anchors (they are re-summarized)', () => {
    const f = new Fixture();
    f.messages('T', 2);
    const b = f.fork('T.1', 'summary', { anchor: 'focus', id: 'S' });
    for (let i = 0; i < 6; i++) f.add(b, i % 2 === 0 ? 'user' : 'assistant', X);
    const first = f.plan(b, { estimateTokens: charTokens });
    const branchKey = summaryKeyString(first.pendingSummaries[0]!.key);
    const summaries = new Map([[branchKey, 'z'.repeat(200)]]);
    const plan = f.plan(b, {
      summaries,
      estimateTokens: charTokens,
      budget: {
        maxInputTokens: 500,
        compactionSummaryTokens: 100,
        minTailMessages: 2,
        compactionTarget: 1,
      },
    });
    // 200 + 5 + 6*104 = 829; dropping summary+anchor+3 messages: 829-517+100 = 412.
    expect(describe(plan)).toEqual(['sum:compaction:pending', `br:${X}`, `br:${X}`, `br:${X}`]);
    const req = plan.pendingSummaries[0]!;
    expect(req.purpose).toBe('compaction');
    expect(req.transcript.slice(0, 3)).toEqual([
      u(`[Summary of earlier conversation] ${'z'.repeat(200)}`),
      u('[Focus excerpt] focus'),
      u(X),
    ]);
    expect(plan.compaction!.compactedNodeIds).toEqual(['T.0', 'T.1', 'S.0', 'S.1', 'S.2']);
    expect(plan.compaction!.key.anchorNodeId).toBe('S.2');
    expect(plan.compaction!.tokensBefore).toBe(829);
  });

  it('a compaction over a pending inner summary stays pending and requests the inner summary', () => {
    const f = new Fixture();
    f.messages('T', 2);
    const b = f.fork('T.1', 'summary', { anchor: 'focus', id: 'S' });
    for (let i = 0; i < 8; i++) f.add(b, i % 2 === 0 ? 'user' : 'assistant', X);
    const input = f.input(b, {
      estimateTokens: charTokens,
      budget: { maxInputTokens: 500, compactionSummaryTokens: 100, minTailMessages: 2 },
    });
    const plan = assembleContext(input);
    expect(describe(plan)[0]).toBe('sum:compaction:pending');
    expect(plan.pendingSummaries.map((r) => r.purpose)).toEqual(['branch']);
    expect(plan.pendingSummaries[0]!.key.anchorNodeId).toBe('T.1');
    const { plan: final, requests } = resolveAll(input);
    expect(requests.map((r) => r.purpose)).toEqual(['branch', 'compaction']);
    expect(final.complete).toBe(true);
    expect(describe(final)[0]).toBe('sum:compaction:ready');
  });

  it.each(MODES)('compacts in %s mode too', (mode) => {
    const f = new Fixture();
    f.messages('T', 2);
    const b = f.fork('T.1', mode);
    for (let i = 0; i < 10; i++) f.add(b, i % 2 === 0 ? 'user' : 'assistant', X);
    const { plan } = resolveAll(
      f.input(b, {
        estimateTokens: charTokens,
        budget: { maxInputTokens: 600, compactionSummaryTokens: 100 },
      }),
    );
    expect(plan.compaction).not.toBeNull();
    expect(plan.segments.at(-1)!.sourceNodeIds).toEqual(['B1.9']);
    expect(plan.budget.usedTokens).toBeLessThanOrEqual(600);
  });

  it('falls back to truncation when the tail alone is too large', () => {
    const f = new Fixture();
    f.systemPrompt = 'SP';
    const big = 'x'.repeat(300);
    f.add('T', 'user', big);
    f.add('T', 'assistant', big);
    f.add('T', 'user', big);
    const plan = f.plan('T', {
      estimateTokens: charTokens,
      budget: { maxInputTokens: 400, compactionSummaryTokens: 100, minTailMessages: 2 },
    });
    expect(plan.compaction).toBeNull();
    expect(describe(plan)).toEqual(['sys:SP', `br:${big}`]);
    expect(plan.segments[1]!.sourceNodeIds).toEqual(['T.2']);
    expect(plan.truncation).toEqual({
      droppedSegmentIds: ['seg-2', 'seg-3'],
      droppedNodeIds: ['T.0', 'T.1'],
      tokensBefore: 2 + 3 * 304,
      tokensAfter: 2 + 304,
    });
    expect(plan.budget.usedTokens).toBe(306);
  });

  it('never drops the system prompt or the target, even if still over budget', () => {
    const f = new Fixture();
    f.systemPrompt = 'SP';
    f.add('T', 'user', 'x'.repeat(50));
    f.add('T', 'assistant', 'x'.repeat(50));
    f.add('T', 'user', 'x'.repeat(1000));
    const plan = f.plan('T', { estimateTokens: charTokens, budget: { maxInputTokens: 100 } });
    expect(describe(plan)).toEqual(['sys:SP', `br:${'x'.repeat(1000)}`]);
    expect(plan.budget.usedTokens).toBe(1006);
    expect(plan.truncation!.droppedNodeIds).toEqual(['T.0', 'T.1']);
  });

  it('truncation keeps the target when minTailMessages is 0', () => {
    const f = long(3);
    const plan = f.plan('T', {
      estimateTokens: charTokens,
      budget: { maxInputTokens: 150, compactionSummaryTokens: 100, minTailMessages: 0 },
    });
    // Candidates are T.0 and T.1 (the target is excluded); 312-208+100 = 204 > 150.
    expect(plan.compaction).toBeNull();
    expect(plan.segments.map((s) => s.sourceNodeIds[0])).toEqual(['T.2']);
  });
});
