import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CONTINUE_MESSAGE, REPLY_ACTION, type ChatNode, type TreeDetail } from '@tangent/shared';
import { BillingClient, Walkthrough } from '@tangent/web-shared';
import {
  appProviders,
  billing,
  branch,
  detail,
  node,
  openTree,
  provider,
  render,
} from '@tangent/web-shared/testing';
import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { branchyLesson, learner, NOT_A_MEMBER, POOL_ON } from '../learn.testing';
import { LessonStore } from '../state/lesson-store';
import { UiStore } from '../state/ui-store';
import { ChatPage } from './chat-page';

const LEARN = provider({
  label: 'Tangent',
  funding: 'credit',
  acceptsUserKey: false,
  keySource: 'server',
  models: [
    { id: 'normal-model', label: 'Normal', tier: 'normal' },
    { id: 'max-model', label: 'Max', tier: 'max', usageFactor: 14 },
  ],
  defaultModel: 'normal-model',
});

/** The lesson "Light": What is light? (u1) → A wave. (a1), on `model`. */
function lesson(model = 'normal-model', reply: Partial<ChatNode> = {}): TreeDetail {
  return detail(
    [
      node('u1', { role: 'user', content: 'What is light?' }),
      node('a1', { parentId: 'u1', seq: 1, content: 'A wave.', ...reply }),
    ],
    [branch('trunk', { title: 'Main thread', model })],
  );
}

/** The walkthrough as the page reports to it: each event a spy. */
function fakeWalkthrough() {
  return {
    current: signal(null),
    onTrunkReplyReady: vi.fn(),
    onEnteredTangent: vi.fn(),
    onBackOnTrunk: vi.fn(),
    onRepliedOnTrunk: vi.fn(),
  };
}

/** The lesson page on `d` (at `branchId`), for what `facts` say of the learner. */
async function page(
  d: TreeDetail = lesson(),
  facts: Parameters<typeof learner>[0] = {},
  branchId: string | null = null,
  walkthrough = fakeWalkthrough(),
) {
  const r = await render(ChatPage, {
    providers: [
      ...appProviders({}),
      { provide: BillingClient, useValue: {} },
      { provide: Walkthrough, useValue: walkthrough },
    ],
    setup: () => {
      learner(facts);
      const store = TestBed.inject(LessonStore);
      store.providers.set([LEARN]);
      openTree(store, d, branchId);
    },
  });
  return { ...r, store: TestBed.inject(LessonStore), user: userEvent.setup() };
}

const composer = () => screen.queryByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
/** Selects "wave" in the reply "Light is a wave of fields.", as dragging over it would. */
function selectWave(): void {
  const text = screen.getByText('Light is a wave of fields.').firstChild!;
  const range = document.createRange();
  range.setStart(text, 11);
  range.setEnd(text, 15);
  window.getSelection()!.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}

const dock = () => composer()?.closest<HTMLElement>('.composer-dock') ?? document.body;

describe('Learn: the lesson page', () => {
  it.each([
    ['the own key', {}, true],
    ['credit', { billing: billing(), chosen: 'credit' }, true],
    ['the pool', { pool: POOL_ON, chosen: 'pool' }, false],
  ] as const)('offers the lesson’s own instructions on %s: %s', async (_payer, facts, shown) => {
    await page(lesson(), facts);
    const button = screen.queryByRole('button', { name: 'Your instructions for this lesson' });
    expect(button !== null).toBe(shown);
  });

  it('after a reply the composer offers Tangent ↳ first and Next ➜, each saying what it is for', async () => {
    await page();
    screen.getByRole('heading', { name: 'Light' });
    expect(screen.getByText('A wave.')).toBeTruthy();
    expect(composer()?.placeholder).toBe('Ask anything…');
    const [tangent, next] = within(dock()).getAllByRole('button', { name: /Tangent ↳|Next ➜/ });
    expect(tangent?.textContent?.trim()).toBe('Tangent ↳');
    expect(tangent?.dataset['action']).toBe('tangent');
    expect(tangent?.title).toBe(
      'Wait, what’s that? Explore on the side without derailing the lesson. (Enter)',
    );
    expect(next?.textContent?.trim()).toBe('Next ➜');
    expect(next?.dataset['action']).toBe('next');
    expect(next?.title).toBe('Got it, what’s next? Keeps the main lesson moving. (Ctrl+Enter)');
    expect(within(dock()).queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('Tangent ↳ goes on a tangent from the last reply; Next ➜ continues the lesson', async () => {
    const p = await page();
    const askFrom = vi.spyOn(p.store, 'askFrom').mockResolvedValue(branch('side'));
    const send = vi.spyOn(p.store, 'send').mockResolvedValue(true);
    await p.user.type(composer()!, 'And a particle?');
    await p.user.click(within(dock()).getByRole('button', { name: 'Tangent ↳' }));
    expect(askFrom).toHaveBeenCalledWith('a1', 'And a particle?', null);
    expect(send).not.toHaveBeenCalled();
    await p.user.click(within(dock()).getByRole('button', { name: 'Next ➜' }));
    expect(send).toHaveBeenCalledWith('trunk', 'And a particle?');
    expect(askFrom).toHaveBeenCalledTimes(1);
  });

  it('Compare stands beside Tangent ↳ and Next ➜, and compares in a tangent from the last reply', async () => {
    const p = await page();
    const createBranch = vi.spyOn(p.store, 'createBranch').mockResolvedValue(branch('side'));
    const open = vi.spyOn(TestBed.inject(UiStore).dialogs, 'open');
    await p.user.type(composer()!, 'And a particle?');
    await p.user.click(within(dock()).getByRole('button', { name: 'Compare Normal and Max' }));
    expect(createBranch).toHaveBeenCalledWith({
      fromNodeId: 'a1',
      contextMode: 'path',
      anchorQuote: null,
    });
    expect(open).toHaveBeenCalledWith({
      kind: 'compare',
      branchId: 'side',
      content: 'And a particle?',
    });
  });

  it('Enter sends as a tangent, Ctrl+Enter as Next', async () => {
    const p = await page();
    const askFrom = vi.spyOn(p.store, 'askFrom').mockResolvedValue(branch('side'));
    const send = vi.spyOn(p.store, 'send').mockResolvedValue(true);
    await p.user.type(composer()!, 'And a particle?{Enter}');
    expect(askFrom).toHaveBeenCalledWith('a1', 'And a particle?', null);
    expect(send).not.toHaveBeenCalled();
    await p.user.keyboard('{Control>}{Enter}{/Control}');
    expect(send).toHaveBeenCalledWith('trunk', 'And a particle?');
  });

  it('inside a tangent, Next ➜ keeps that tangent moving', async () => {
    const p = await page(branchyLesson(), {}, 'side');
    expect(composer()?.placeholder).toBe('Ask anything in this tangent…');
    const next = within(dock()).getByRole('button', { name: 'Next ➜' });
    expect(next.title).toBe('Got it, what’s next? Keeps this tangent moving. (Ctrl+Enter)');
    const send = vi.spyOn(p.store, 'send').mockResolvedValue(true);
    await p.user.type(composer()!, 'More?');
    await p.user.click(next);
    expect(send).toHaveBeenCalledWith('side', 'More?');
  });

  it('a new lesson has nothing to go on a tangent from: a single Send', async () => {
    const p = await page(detail([], [branch('trunk', { title: 'Main thread' })]));
    expect(within(dock()).queryByRole('button', { name: /Tangent ↳|Next ➜/ })).toBeNull();
    within(dock()).getByRole('button', { name: 'Send' });
    const send = vi.spyOn(p.store, 'send').mockResolvedValue(true);
    await p.user.type(composer()!, 'Light?{Enter}');
    expect(send).toHaveBeenCalledWith('trunk', 'Light?');
  });

  it('a reply that failed is continued: the composer offers no tangent', async () => {
    const p = await page(lesson('normal-model', { status: 'error', error: 'It broke.' }));
    expect(within(dock()).queryByRole('button', { name: /Tangent ↳|Next ➜/ })).toBeNull();
    expect(composer()?.placeholder).toBe('Ask anything…');
    const send = vi.spyOn(p.store, 'send').mockResolvedValue(true);
    await p.user.type(composer()!, 'Again?{Enter}');
    expect(send).toHaveBeenCalledWith('trunk', 'Again?');
  });

  it('"Ask about this" puts the selected words on the composer and asks about them', async () => {
    const p = await page(lesson('normal-model', { content: 'Light is a wave of fields.' }));
    selectWave();
    await p.fixture.whenStable();
    const createBranch = vi.spyOn(p.store, 'createBranch');
    await p.user.click(screen.getByRole('button', { name: 'Ask about this' }));
    // Nothing is made until the question is sent.
    expect(createBranch).not.toHaveBeenCalled();
    within(dock()).getByText('“wave”');
    expect(composer()?.placeholder).toBe('Ask about this…');
    // Words to ask about only go on a tangent.
    within(dock()).getByRole('button', { name: 'Tangent ↳' });
    expect(within(dock()).queryByRole('button', { name: 'Next ➜' })).toBeNull();
    expect(document.activeElement).toBe(composer());
    const askFrom = vi.spyOn(p.store, 'askFrom').mockResolvedValue(branch('side'));
    await p.user.type(composer()!, 'Of what?{Enter}');
    expect(askFrom).toHaveBeenCalledWith('a1', 'Of what?', 'wave');
    await p.fixture.whenStable();
    expect(within(dock()).queryByText('“wave”')).toBeNull();
  });

  it('a quote on the composer can be taken off again', async () => {
    const p = await page(lesson('normal-model', { content: 'Light is a wave of fields.' }));
    selectWave();
    await p.fixture.whenStable();
    await p.user.click(screen.getByRole('button', { name: 'Ask about this' }));
    await p.user.click(within(dock()).getByRole('button', { name: 'Don’t ask about “wave”' }));
    expect(within(dock()).queryByText('“wave”')).toBeNull();
    expect(composer()?.placeholder).toBe('Ask anything…');
  });

  it('inside an empty tangent the composer asks it, with nothing to choose', async () => {
    const d = lesson();
    d.branches.push(
      branch('side', { parentBranchId: 'trunk', branchPointNodeId: 'a1', title: 'Why' }),
    );
    const p = await page(d, {}, 'side');
    expect(within(dock()).queryByRole('button', { name: /Tangent ↳|Next ➜/ })).toBeNull();
    expect(composer()?.placeholder).toBe('Ask your tangent…');
    const send = vi.spyOn(p.store, 'send').mockResolvedValue(true);
    await p.user.type(composer()!, 'Why?{Enter}');
    expect(send).toHaveBeenCalledWith('side', 'Why?');
  });

  it('the tutor switch: Normal or Max, and on Max how much more it uses', async () => {
    const p = await page(lesson('max-model'));
    const tutor = screen.getByRole('radiogroup', { name: 'Tutor' });
    expect(within(tutor).getByRole('radio', { name: 'Max' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(within(dock()).getByRole('status').textContent).toBe(
      'Max uses about 14× as much as Normal.',
    );
    const setModel = vi.spyOn(p.store, 'setModel').mockResolvedValue(true);
    await p.user.click(within(tutor).getByRole('radio', { name: 'Normal' }));
    expect(setModel).toHaveBeenCalledWith('trunk', 'normal-model');
  });

  it('on the open pool, which uses Lite: says so in visible text, and offers no Compare', async () => {
    await page(lesson('lite-model'), { pool: POOL_ON, chosen: 'pool' });
    expect(screen.queryByRole('radiogroup', { name: 'Tutor' })).toBeNull();
    expect(screen.getByText(/The open pool uses Lite/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Compare Normal and Max' })).toBeNull();
  });

  it('with both credit and the pool to pay with, the composer offers the choice', async () => {
    const p = await page(lesson(), {
      billing: billing({ availableMicros: 500_000 }),
      pool: POOL_ON,
      chosen: 'credit',
    });
    const pay = within(dock()).getByRole('radiogroup', { name: 'Pay for replies with' });
    expect(within(pay).getByRole('radio', { name: 'My credit' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    await p.user.click(within(pay).getByRole('radio', { name: 'Open pool' }));
    await p.fixture.whenStable();
    expect(within(pay).getByRole('radio', { name: 'Open pool' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('credit picked but used up: the composer says replies use the pool meanwhile', async () => {
    await page(lesson(), { billing: billing(), pool: POOL_ON, chosen: 'credit' });
    const note = within(dock()).getByText(/Your credit is used up, so replies use the open pool/);
    expect(note.textContent).toContain("which can't compare answers or check sources");
    expect(within(note).getByRole('link', { name: 'Add credit' }).getAttribute('href')).toBe(
      '/billing',
    );
  });

  it('the own key locked by the membership: the ways out stand where the composer was', async () => {
    await page(lesson(), { membership: NOT_A_MEMBER, chosen: 'own-key', pool: POOL_ON });
    expect(composer()).toBeNull();
    screen.getByRole('region', { name: 'Replies on your own key need a membership.' });
    screen.getByRole('button', { name: 'Continue on the open pool' });
  });

  it('the pool refusing a message shows inline above the composer, and can be dismissed', async () => {
    const p = await page(lesson(), { pool: POOL_ON, chosen: 'pool' });
    p.store.poolBlock.set({
      kind: 'empty',
      details: { reason: 'empty', limit: null, resetAt: null },
      branchId: 'trunk',
    });
    await p.fixture.whenStable();
    expect(within(dock()).getByRole('status').textContent).toContain(
      'The open pool is empty until Tangent adds more credit.',
    );
    await p.user.click(within(dock()).getByRole('button', { name: 'Dismiss' }));
    expect(p.store.poolBlock()).toBeNull();
  });

  it('follows a long reply only until its start reaches the top of the view', async () => {
    const p = await page(lesson('normal-model', { status: 'streaming', content: '' }));
    // jsdom lays nothing out: a 500px view on 3000px of lesson, the reply 400px down.
    const scroller = document.querySelector<HTMLElement>('.messages')!;
    let scrollTop = 0;
    Object.defineProperties(scroller, {
      scrollHeight: { value: 3000 },
      clientHeight: { value: 500 },
      scrollTop: { get: () => scrollTop, set: (v: number) => (scrollTop = v) },
    });
    const reply = document.getElementById('msg-a1')!;
    reply.getBoundingClientRect = () => new DOMRect(0, 400 - scrollTop, 600, 2600);

    p.store.live.set(
      new Map([
        [
          'a1',
          {
            nodeId: 'a1',
            treeId: 't1',
            branchId: 'trunk',
            content: 'A wave.',
            status: null,
            reconnecting: false,
          },
        ],
      ]),
    );
    await vi.waitFor(() => expect(scrollTop).toBe(400));
  });

  it('a reply cut off at its length limit says "Cut off." with Continue, not that it failed', async () => {
    const p = await page(
      lesson('normal-model', { status: 'error', errorKind: 'cut_off', error: 'It hit the limit.' }),
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Cut off.');
    expect(alert.textContent).not.toContain('The reply failed.');
    const send = vi.spyOn(p.store, 'send').mockResolvedValue(true);
    await p.user.click(within(alert).getByRole('button', { name: 'Continue' }));
    expect(send).toHaveBeenCalledWith('trunk', CONTINUE_MESSAGE);
  });
});

describe('Learn: finding your way around a lesson', () => {
  it('the path goes back to the message each tangent started from, first to the main thread', async () => {
    const p = await page(branchyLesson(), {}, 'deep');
    const path = screen.getByRole('navigation', { name: 'Tangent path' });
    const go = vi.spyOn(p.store, 'go').mockImplementation(() => undefined);
    const main = within(path).getByRole('button', { name: 'Main thread' });
    expect(main.title).toBe('Back to main thread');
    expect(main.dataset['coach']).toBe('main-thread');
    await p.user.click(main);
    expect(go).toHaveBeenLastCalledWith('trunk', 'a1');
    await p.user.click(within(path).getByRole('button', { name: 'Particles' }));
    expect(go).toHaveBeenLastCalledWith('side', 'a2');
    expect(within(path).getByText('Duality').getAttribute('aria-current')).toBe('page');
  });

  it('a tangent opens at its first message, from under the message it started from', async () => {
    const p = await page(branchyLesson());
    const go = vi.spyOn(p.store, 'go').mockImplementation(() => undefined);
    const reply = within(document.getElementById('msg-a1')!);
    const yours = within(reply.getByRole('group', { name: 'Your tangents' }));
    // In the sidebar's order.
    const rows = yours.getAllByRole('button', { name: /^Open tangent/ });
    expect(rows.map((b) => b.textContent?.trim())).toEqual([
      'Open tangent: Why waves',
      'Open tangent: Particles',
    ]);
    await p.user.click(yours.getByRole('button', { name: 'Open tangent: Particles' }));
    expect(go).toHaveBeenLastCalledWith('side', 'u2');
  });

  it('a tangent is deleted from under its message, once the learner says so', async () => {
    const p = await page(branchyLesson());
    const del = vi.spyOn(p.store, 'deleteSideQuestion').mockResolvedValue(true);
    const ask = vi.fn(() => false);
    vi.stubGlobal('confirm', ask);
    try {
      const trash = screen.getByRole('button', { name: 'Delete the tangent Why waves' });
      await p.user.click(trash);
      expect(ask).toHaveBeenCalledWith(
        'Delete “Why waves” (1 message)? Replies still being written there are stopped. This cannot be undone.',
      );
      expect(del).not.toHaveBeenCalled();
      ask.mockReturnValue(true);
      await p.user.click(trash);
      expect(del).toHaveBeenCalledWith('other');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('clicking a message marks it; clicking a control in it does not', async () => {
    const p = await page();
    const focus = vi.spyOn(p.store, 'focus').mockImplementation(() => undefined);
    await p.user.click(screen.getByText('A wave.'));
    expect(focus).toHaveBeenCalledWith('a1');
    focus.mockClear();
    vi.spyOn(p.store, 'createBranch').mockResolvedValue(null);
    const reply = document.getElementById('msg-a1')!;
    await p.user.click(within(reply).getByRole('button', { name: 'Tangent ↳' }));
    expect(focus).not.toHaveBeenCalled();
  });
});

/** A reply ending with suggestions: one to keep going, one tangent, and one the model left untagged. */
const SUGGESTED = [
  'A wave.',
  '',
  '<tangents>',
  '- [continue] Colour — what sets it',
  '- [tangent] Photons — the particle side',
  '- Diffraction — how it bends round edges',
  '</tangents>',
].join('\n');

/** A reply suggesting one next step, with no reason given. */
const ONE_STEP = 'A wave.\n\n<tangents>\n- [continue] Next\n</tangents>';
const nextStep = () =>
  within(screen.getByRole('group', { name: 'Keep going' })).getByRole<HTMLButtonElement>('button', {
    name: 'Next',
  });

describe('Learn: suggestions after a reply', () => {
  it('come in two labelled groups, an untagged one under Suggested tangents', async () => {
    await page(lesson('normal-model', { content: SUGGESTED }));
    const keep = screen.getByRole('group', { name: 'Keep going' });
    const side = screen.getByRole('group', { name: 'Suggested tangents' });
    expect(within(keep).getByText('Keep going')).toBeTruthy();
    const titles = (group: HTMLElement) =>
      within(group)
        .getAllByRole('button')
        .map((b) => b.querySelector('.tangent-title')?.textContent);
    expect(titles(keep)).toEqual(['Colour']);
    expect(titles(side)).toEqual(['Photons', 'Diffraction']);
  });

  it('Keep going sends the suggestion as the lesson’s next message', async () => {
    const p = await page(lesson('normal-model', { content: SUGGESTED }));
    const continueWith = vi.spyOn(p.store, 'continueWith').mockResolvedValue(true);
    const follow = vi.spyOn(p.store, 'followTangent').mockResolvedValue(null);
    const keep = screen.getByRole('group', { name: 'Keep going' });
    await p.user.click(within(keep).getByRole('button', { name: /Colour/ }));
    expect(continueWith).toHaveBeenCalledWith('a1', 'Colour');
    expect(follow).not.toHaveBeenCalled();
  });

  it('a tangent suggestion opens a tangent of its own', async () => {
    const p = await page(lesson('normal-model', { content: SUGGESTED }));
    const follow = vi.spyOn(p.store, 'followTangent').mockResolvedValue(null);
    const side = screen.getByRole('group', { name: 'Suggested tangents' });
    await p.user.click(within(side).getByRole('button', { name: /Photons/ }));
    expect(follow).toHaveBeenCalledWith('a1', 'Photons');
  });

  it('a followed one shows once, under Your tangents, and the rest fold away', async () => {
    const d = lesson('normal-model', { content: SUGGESTED });
    d.branches.push(
      branch('photons', {
        title: 'Photons',
        titleSource: 'user',
        parentBranchId: 'trunk',
        branchPointNodeId: 'a1',
      }),
    );
    const p = await page(d);
    const go = vi.spyOn(p.store, 'go').mockImplementation(() => undefined);
    const yours = within(screen.getByRole('group', { name: 'Your tangents' }));
    const photons = yours.getByRole('button', { name: 'Open tangent: Photons' });
    expect(photons.title).toBe('the particle side');
    const more = screen.getByRole('button', { name: '1 more suggested' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: /Photons the particle side/ })).toBeNull();
    await p.user.click(more);
    within(screen.getByRole('group', { name: 'Suggested tangents' })).getByRole('button', {
      name: /^Start a tangent: Diffraction/,
    });
    await p.user.click(photons);
    expect(go).toHaveBeenLastCalledWith('photons', null);
  });

  it('Keep going shows only on the latest reply; older ones keep their tangents', async () => {
    const d = lesson('normal-model', { content: SUGGESTED });
    d.nodes.push(
      node('u2', { parentId: 'a1', seq: 2, role: 'user', content: 'Colour' }),
      node('a2', { parentId: 'u2', seq: 3, content: 'By frequency.' }),
    );
    await page(d);
    const older = document.getElementById('msg-a1')!;
    expect(within(older).queryByRole('group', { name: 'Keep going' })).toBeNull();
    within(older).getByRole('group', { name: 'Suggested tangents' });
  });

  it('Keep going says it keeps the lesson moving', async () => {
    await page(lesson('normal-model', { content: ONE_STEP }));
    expect(nextStep().title).toBe(REPLY_ACTION.hint);
  });

  it('inside a tangent, Keep going says it keeps that tangent moving', async () => {
    const d = branchyLesson();
    await page(
      { ...d, nodes: d.nodes.map((n) => (n.id === 'a3' ? { ...n, content: ONE_STEP } : n)) },
      {},
      'deep',
    );
    expect(nextStep().title).toBe(REPLY_ACTION.hintInTangent);
  });
});

describe('Learn: what the lesson page tells the walkthrough', () => {
  it('a reply on the main thread, with Tangent ↳ under it: step 1 can show', async () => {
    const w = fakeWalkthrough();
    await page(lesson(), {}, null, w);
    await vi.waitFor(() => expect(w.onTrunkReplyReady).toHaveBeenCalled());
    expect(w.onEnteredTangent).not.toHaveBeenCalled();
  });

  it.each([
    ['a new lesson', detail([], [branch('trunk', { title: 'Main thread' })])],
    ['a reply still being written', lesson('normal-model', { status: 'streaming', content: '' })],
  ])('%s: not yet', async (_case, d) => {
    const w = fakeWalkthrough();
    await page(d, {}, null, w);
    expect(w.onTrunkReplyReady).not.toHaveBeenCalled();
    expect(w.onBackOnTrunk).not.toHaveBeenCalled();
    expect(w.onEnteredTangent).not.toHaveBeenCalled();
  });

  it('inside a tangent, however it was entered: step 2; back on the main thread: step 3', async () => {
    const w = fakeWalkthrough();
    const p = await page(branchyLesson(), {}, 'side', w);
    await vi.waitFor(() => expect(w.onEnteredTangent).toHaveBeenCalled());
    expect(w.onBackOnTrunk).not.toHaveBeenCalled();
    p.store.setRoute('t1', null, null);
    await p.fixture.whenStable();
    await vi.waitFor(() => expect(w.onBackOnTrunk).toHaveBeenCalled());
  });

  it('a reply sent with Next ➜ on the main thread, which step 3 asks for', async () => {
    const w = fakeWalkthrough();
    const p = await page(lesson(), {}, null, w);
    vi.spyOn(p.store, 'askFrom').mockResolvedValue(branch('side'));
    vi.spyOn(p.store, 'send').mockResolvedValue(true);
    await p.user.type(composer()!, 'And a particle?');
    await p.user.click(within(dock()).getByRole('button', { name: 'Tangent ↳' }));
    expect(w.onRepliedOnTrunk).not.toHaveBeenCalled();
    await p.user.click(within(dock()).getByRole('button', { name: 'Next ➜' }));
    expect(w.onRepliedOnTrunk).toHaveBeenCalledOnce();
  });

  it('a reply sent with Next ➜ inside a tangent: not the main thread', async () => {
    const w = fakeWalkthrough();
    const p = await page(branchyLesson(), {}, 'side', w);
    vi.spyOn(p.store, 'send').mockResolvedValue(true);
    await p.user.type(composer()!, 'More?');
    await p.user.click(within(dock()).getByRole('button', { name: 'Next ➜' }));
    expect(w.onRepliedOnTrunk).not.toHaveBeenCalled();
  });

  it('a replay from the help, which closes it, is told the screen again', async () => {
    const w = fakeWalkthrough();
    const p = await page(lesson(), {}, null, w);
    await vi.waitFor(() => expect(w.onTrunkReplyReady).toHaveBeenCalled());
    const ui = TestBed.inject(UiStore);
    ui.dialogs.open({ kind: 'help' });
    await p.fixture.whenStable();
    const before = w.onTrunkReplyReady.mock.calls.length;
    ui.dialogs.close('help');
    await p.fixture.whenStable();
    await vi.waitFor(() => expect(w.onTrunkReplyReady.mock.calls.length).toBeGreaterThan(before));
  });
});
