import { TestBed } from '@angular/core/testing';
import { CONTINUE_MESSAGE, type ChatNode, type TreeDetail } from '@tangent/shared';
import { BillingClient } from '@tangent/web-shared';
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

/** The lesson page on `d` (at `branchId`), for what `facts` say of the learner. */
async function page(
  d: TreeDetail = lesson(),
  facts: Parameters<typeof learner>[0] = {},
  branchId: string | null = null,
) {
  const r = await render(ChatPage, {
    providers: [...appProviders({}), { provide: BillingClient, useValue: {} }],
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

  it('shows the lesson, and the composer asks a side question from its last reply', async () => {
    const p = await page();
    screen.getByRole('heading', { name: 'Light' });
    expect(screen.getByText('A wave.')).toBeTruthy();
    expect(composer()?.placeholder).toBe('Ask a side question…');
    const askFrom = vi.spyOn(p.store, 'askFrom').mockResolvedValue(branch('side'));
    const send = vi.spyOn(p.store, 'send').mockResolvedValue(true);
    await p.user.type(composer()!, 'And a particle?{Enter}');
    expect(askFrom).toHaveBeenCalledWith('a1', 'And a particle?', null);
    expect(send).not.toHaveBeenCalled();
  });

  it('the composer’s destination switches to continuing the lesson, and back', async () => {
    const p = await page();
    const send = vi.spyOn(p.store, 'send').mockResolvedValue(true);
    await p.user.click(within(dock()).getByRole('button', { name: 'Send as: Side question' }));
    expect(composer()?.placeholder).toBe('Continue this lesson…');
    expect(document.activeElement).toBe(composer());
    await p.user.type(composer()!, 'And a particle?{Enter}');
    expect(send).toHaveBeenCalledWith('trunk', 'And a particle?');
    await p.user.click(within(dock()).getByRole('button', { name: 'Send as: Continue' }));
    expect(composer()?.placeholder).toBe('Ask a side question…');
  });

  it('a reply that failed is continued: the composer offers no side question', async () => {
    const p = await page(lesson('normal-model', { status: 'error', error: 'It broke.' }));
    expect(within(dock()).queryByRole('button', { name: /Send as/ })).toBeNull();
    expect(composer()?.placeholder).toBe('Continue this lesson…');
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
    expect(composer()?.placeholder).toBe('Ask a side question…');
  });

  it('inside an empty side question the composer asks it, with nothing to choose', async () => {
    const d = lesson();
    d.branches.push(
      branch('side', { parentBranchId: 'trunk', branchPointNodeId: 'a1', title: 'Why' }),
    );
    const p = await page(d, {}, 'side');
    expect(within(dock()).queryByRole('button', { name: /Send as/ })).toBeNull();
    expect(composer()?.placeholder).toBe('Ask your side question…');
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
  it('the path goes back to the message each side question started from', async () => {
    const p = await page(branchyLesson(), {}, 'deep');
    const path = screen.getByRole('navigation', { name: 'Side question path' });
    const go = vi.spyOn(p.store, 'go').mockImplementation(() => undefined);
    await p.user.click(within(path).getByRole('button', { name: 'Lesson' }));
    expect(go).toHaveBeenLastCalledWith('trunk', 'a1');
    await p.user.click(within(path).getByRole('button', { name: 'Particles' }));
    expect(go).toHaveBeenLastCalledWith('side', 'a2');
    expect(within(path).getByText('Duality').getAttribute('aria-current')).toBe('page');
  });

  it('a side question opens at its first message', async () => {
    const p = await page(branchyLesson());
    const go = vi.spyOn(p.store, 'go').mockImplementation(() => undefined);
    const list = screen.getByRole('navigation', { name: 'Side questions from this message' });
    await p.user.click(within(list).getByRole('button', { name: 'Particles' }));
    expect(go).toHaveBeenLastCalledWith('side', 'u2');
  });

  it('clicking a message marks it; clicking a control in it does not', async () => {
    const p = await page();
    const focus = vi.spyOn(p.store, 'focus').mockImplementation(() => undefined);
    await p.user.click(screen.getByText('A wave.'));
    expect(focus).toHaveBeenCalledWith('a1');
    focus.mockClear();
    vi.spyOn(p.store, 'createBranch').mockResolvedValue(null);
    await p.user.click(screen.getByRole('button', { name: 'Side question' }));
    expect(focus).not.toHaveBeenCalled();
  });
});
