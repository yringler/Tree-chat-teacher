import { describe, expect, it } from 'vitest';
import {
  composerExcerpt,
  composerPlan,
  replyToAim,
  type ComposerFacts,
  type ComposerMessage,
  type ComposerSend,
} from './composer-plan.js';
import type { NodeStatus } from './domain.js';
import { REPLY_ACTION, TANGENT_ACTION } from './tangent-help.js';

const question = (id: string, branchId = 'trunk'): ComposerMessage => ({
  id,
  branchId,
  role: 'user',
  status: 'complete',
});

const reply = (
  id: string,
  branchId = 'trunk',
  status: NodeStatus = 'complete',
): ComposerMessage => ({
  id,
  branchId,
  role: 'assistant',
  status,
});

/** The main thread: u1 a1 u2 a2. */
const MAIN = [question('u1'), reply('a1'), question('u2'), reply('a2')];

/** The tangent `side` from a1, as it is shown: u1 a1, then its own u3 a3 u4 a4. */
const SIDE = [
  question('u1'),
  reply('a1'),
  question('u3', 'side'),
  reply('a3', 'side'),
  question('u4', 'side'),
  reply('a4', 'side'),
];

function onMain(over: Partial<ComposerFacts> = {}): ComposerFacts {
  return { path: MAIN, branchId: 'trunk', inTangent: false, focusedId: null, lead: null, ...over };
}

function inSide(over: Partial<ComposerFacts> = {}): ComposerFacts {
  return { path: SIDE, branchId: 'side', inTangent: true, focusedId: null, lead: null, ...over };
}

const TANGENT: ComposerSend = {
  id: 'tangent',
  label: TANGENT_ACTION.label,
  hint: TANGENT_ACTION.hint,
  primary: true,
};

describe('composerPlan', () => {
  it('a new conversation: a plain Send, from the start', () => {
    expect(composerPlan(onMain({ path: [] }))).toEqual({
      target: null,
      actions: [],
      place: 'start',
      nameTarget: false,
    });
  });

  it('after a reply on the main thread: Tangent ↳ from it, filled, and Next ➜ on the main thread', () => {
    expect(composerPlan(onMain())).toEqual({
      target: 'a2',
      actions: [
        TANGENT,
        { id: 'next', label: REPLY_ACTION.label, hint: REPLY_ACTION.hint, primary: false },
      ],
      place: 'main',
      nameTarget: false,
    });
  });

  it('inside a tangent: Tangent ↳ from its last reply, and Next ➜ continues the tangent, filled', () => {
    expect(composerPlan(inSide())).toEqual({
      target: 'a4',
      actions: [
        { ...TANGENT, primary: false },
        { id: 'next', label: REPLY_ACTION.label, hint: REPLY_ACTION.hintInTangent, primary: true },
      ],
      place: 'tangent',
      nameTarget: false,
    });
  });

  it('a tangent opened at its start: from its first reply, named', () => {
    const plan = composerPlan(inSide({ focusedId: 'u3' }));
    expect(plan.target).toBe('a3');
    expect(plan.nameTarget).toBe(true);
    expect(plan.actions.map((a) => a.id)).toEqual(['tangent', 'next']);
  });

  it('a focused reply of the open thread: from it, named unless it is the last', () => {
    expect(composerPlan(onMain({ focusedId: 'a1' }))).toMatchObject({
      target: 'a1',
      nameTarget: true,
    });
    expect(composerPlan(onMain({ focusedId: 'a2' }))).toMatchObject({
      target: 'a2',
      nameTarget: false,
    });
  });

  it('a focused message of an earlier thread is context: from the open thread’s last reply', () => {
    for (const focusedId of ['u1', 'a1']) {
      expect(composerPlan(inSide({ focusedId }))).toMatchObject({
        target: 'a4',
        nameTarget: false,
      });
    }
  });

  it('a focused reply that failed, or the question it answers: from the last reply', () => {
    const path = [question('u1'), reply('a1', 'trunk', 'error'), question('u2'), reply('a2')];
    for (const focusedId of ['u1', 'a1']) {
      expect(composerPlan(onMain({ path, focusedId })).target).toBe('a2');
    }
  });

  it('the last reply failed: a plain Send that continues, unless a finished reply is focused', () => {
    const path = [...MAIN.slice(0, 3), reply('a2', 'trunk', 'error')];
    expect(composerPlan(onMain({ path }))).toMatchObject({
      target: null,
      actions: [],
      place: 'main',
    });
    // The question whose reply failed has nothing to go on from either.
    expect(composerPlan(onMain({ path, focusedId: 'u2' })).target).toBeNull();
    expect(composerPlan(onMain({ path, focusedId: 'a1' }))).toMatchObject({
      target: 'a1',
      nameTarget: true,
    });
  });

  it('aimed at a message: only Tangent ↳, filled, from it, though it is in an earlier thread', () => {
    expect(
      composerPlan(inSide({ lead: { nodeId: 'a1', quote: 'wave' }, focusedId: 'u3' })),
    ).toEqual({ target: 'a1', actions: [TANGENT], place: 'lead', nameTarget: false });
  });

  it('an empty tangent: a plain Send that starts it, or Tangent ↳ once aimed', () => {
    const empty = inSide({ path: SIDE.slice(0, 2), branchId: 'empty' });
    expect(composerPlan(empty)).toEqual({
      target: null,
      actions: [],
      place: 'emptyTangent',
      nameTarget: false,
    });
    expect(composerPlan({ ...empty, lead: { nodeId: 'a1', quote: null } })).toMatchObject({
      target: 'a1',
      actions: [TANGENT],
      place: 'lead',
    });
  });
});

describe('replyToAim', () => {
  it('the focused reply, or the finished reply that answers a focused question', () => {
    expect(replyToAim(MAIN, 'a1')).toBe('a1');
    expect(replyToAim(MAIN, 'u2')).toBe('a2');
  });

  it('a message of an earlier thread too: aiming is how a tangent from it is asked', () => {
    expect(replyToAim(SIDE, 'u1')).toBe('a1');
  });

  it('nothing focused that resolves: the last message, once it is a finished reply', () => {
    expect(replyToAim(SIDE, null)).toBe('a4');
    const failed = [...MAIN.slice(0, 3), reply('a2', 'trunk', 'error')];
    expect(replyToAim(failed, 'u2')).toBeNull();
    expect(
      replyToAim([...MAIN, question('u5'), reply('a5', 'trunk', 'streaming')], null),
    ).toBeNull();
  });
});

describe('composerExcerpt', () => {
  it("names a message by its opening words, as plain text, without a reply's tangents", () => {
    expect(composerExcerpt('**Light** is a wave.\n\n<tangents>\n- Photons\n</tangents>')).toBe(
      'Light is a wave.',
    );
    expect(composerExcerpt('word '.repeat(20))).toBe(`${'word '.repeat(11)}word…`);
  });
});
