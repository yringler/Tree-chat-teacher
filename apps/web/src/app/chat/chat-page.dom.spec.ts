import { TestBed } from '@angular/core/testing';
import { REPLY_ACTION, TANGENT_ACTION, type TreeDetail } from '@tangent/shared';
import { ApiClient, ComposerController } from '@tangent/web-shared';
import {
  branch,
  detail,
  layOutThread,
  membership,
  node,
  openTree,
  powerProviders,
  provider,
  render,
  signIn,
} from '@tangent/web-shared/testing';
import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { ChatPage } from './chat-page';

/** "Light": u1 → a1 on the trunk (own key), and "On credit" off a1, with nothing in it yet. */
function tree(): TreeDetail {
  return detail(
    [
      node('u1', { role: 'user', content: 'What is light?' }),
      node('a1', { parentId: 'u1', seq: 1, content: 'A wave.' }),
    ],
    [
      branch('trunk', { title: 'Main thread' }),
      branch('side', {
        parentBranchId: 'trunk',
        branchPointNodeId: 'a1',
        title: 'On credit',
        funding: 'credit',
        anchorQuote: 'A wave',
      }),
    ],
  );
}

/** "Light" with two tangents off its reply: "Particles" (u2 → a2) and "Why waves" (u3 → a3). */
function branchy(): TreeDetail {
  return detail(
    [
      node('u1', { role: 'user', content: 'What is light?' }),
      node('a1', { parentId: 'u1', seq: 1, content: 'A wave.' }),
      node('u2', { parentId: 'a1', seq: 2, branchId: 'side', role: 'user', content: 'And?' }),
      node('a2', { parentId: 'u2', seq: 3, branchId: 'side', content: 'A particle.' }),
      node('u3', { parentId: 'a1', seq: 2, branchId: 'other', role: 'user', content: 'Why?' }),
      node('a3', { parentId: 'u3', seq: 3, branchId: 'other', content: 'Interference.' }),
    ],
    [
      branch('trunk', { title: 'Main thread' }),
      branch('side', { parentBranchId: 'trunk', branchPointNodeId: 'a1', title: 'Particles' }),
      branch('other', { parentBranchId: 'trunk', branchPointNodeId: 'a1', title: 'Why waves' }),
    ],
  );
}

/** Tangent credit with Normal and Max, so Compare is offered. */
const CREDIT = provider({
  funding: 'credit',
  acceptsUserKey: false,
  keySource: 'server',
  models: [
    { id: 'normal', label: 'Normal', tier: 'normal' },
    { id: 'max', label: 'Max', tier: 'max' },
  ],
});

async function page(opts: { branchId?: string; lapsed?: boolean; d?: TreeDetail | null } = {}) {
  const r = await render(ChatPage, {
    providers: powerProviders(TreeStore, {}),
    setup: () => {
      const store = TestBed.inject(TreeStore);
      signIn(store.account, {
        membership: opts.lapsed
          ? membership({ status: 'inactive', subscriptionStatus: 'canceled' })
          : undefined,
        providers: [provider(), CREDIT],
        builtInCredit: true,
        billing: { availableMicros: 1_000_000, enabled: true } as never,
      });
      if (opts.d !== null) openTree(store, opts.d ?? tree(), opts.branchId ?? null);
    },
  });
  return {
    ...r,
    store: TestBed.inject(TreeStore),
    ui: TestBed.inject(UiStore),
    user: userEvent.setup(),
  };
}

const composer = () => screen.queryByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
const dock = () => composer()?.closest<HTMLElement>('.composer-dock') ?? document.body;
/** Message `nodeId`'s own Tangent ↳. */
const tangentOf = (nodeId: string) =>
  within(document.getElementById(`msg-${nodeId}`)!).getByRole('button', { name: 'Tangent ↳' });

/** Selects "wave" in reply a1 ("A wave."), as the user would. */
function selectWave(): void {
  const text = screen.getByText('A wave.').firstChild!;
  const range = document.createRange();
  range.setStart(text, 2);
  range.setEnd(text, 6);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}

/** "Light" with a second exchange in "Particles": u2 → a2, then u4 → a4. */
function longerSide(): TreeDetail {
  const d = branchy();
  d.nodes.push(
    node('u4', { parentId: 'a2', seq: 4, branchId: 'side', role: 'user', content: 'How so?' }),
    node('a4', { parentId: 'u4', seq: 5, branchId: 'side', content: 'In lumps.' }),
  );
  return d;
}

describe('ChatPage', () => {
  it('after a reply the composer offers Tangent ↳, with its options, and Next ➜, and Compare', async () => {
    await page();
    const chat = screen.getByRole('region', { name: 'Conversation' });
    expect(within(chat).getByText('What is light?')).toBeTruthy();
    expect(within(chat).getByText('A wave.')).toBeTruthy();
    expect(composer()?.placeholder).toBe('Ask anything…');
    const [tangent, next] = within(dock()).getAllByRole('button', { name: /^(Tangent|Next)$/ });
    expect(tangent?.textContent?.trim()).toBe('Tangent ↳');
    expect(tangent?.title).toBe(`${TANGENT_ACTION.hint} (Enter)`);
    expect(tangent?.classList).toContain('btn-primary');
    expect(next?.textContent?.trim()).toBe('Next ➜');
    expect(next?.title).toBe(`${REPLY_ACTION.hint} (Ctrl+Enter)`);
    const caret = within(dock()).getByRole('button', { name: 'Tangent with options…' });
    expect(caret.getAttribute('aria-haspopup')).toBe('dialog');
    within(dock()).getByRole('button', { name: 'Compare Normal and Max' });
    expect(within(dock()).queryByRole('button', { name: 'Send message' })).toBeNull();
  });

  it('on the main thread, Enter goes on a tangent from the last reply, Ctrl+Enter continues it', async () => {
    const p = await page();
    const askFrom = vi.spyOn(p.store, 'askFrom').mockResolvedValue(branch('new'));
    const send = vi.spyOn(p.store, 'send').mockResolvedValue(true);
    await p.user.type(composer()!, 'And a particle?{Enter}');
    expect(askFrom).toHaveBeenCalledWith('a1', 'And a particle?', null);
    expect(send).not.toHaveBeenCalled();
    await p.user.keyboard('{Control>}{Enter}{/Control}');
    expect(send).toHaveBeenCalledWith('trunk', 'And a particle?');
    expect(askFrom).toHaveBeenCalledTimes(1);
  });

  it('inside a tangent, Next ➜ is filled: Enter continues it, Ctrl+Enter goes one level down', async () => {
    const p = await page({ d: branchy(), branchId: 'side' });
    expect(composer()?.placeholder).toBe('Ask anything in this tangent…');
    const [tangent, next] = within(dock()).getAllByRole('button', { name: /^(Tangent|Next)$/ });
    expect(tangent?.classList).not.toContain('btn-primary');
    expect(next?.classList).toContain('btn-primary');
    expect(next?.title).toBe(`${REPLY_ACTION.hintInTangent} (Enter)`);
    const askFrom = vi.spyOn(p.store, 'askFrom').mockResolvedValue(branch('deeper'));
    const send = vi.spyOn(p.store, 'send').mockResolvedValue(true);
    await p.user.type(composer()!, 'More?{Enter}');
    expect(send).toHaveBeenCalledWith('side', 'More?');
    expect(askFrom).not.toHaveBeenCalled();
    await p.user.keyboard('{Control>}{Enter}{/Control}');
    expect(askFrom).toHaveBeenCalledWith('a2', 'More?', null);
  });

  it('a tangent opened at its start goes on from its first reply, and the box names it', async () => {
    const p = await page({ d: longerSide() });
    composer()!.blur();
    p.store.setRoute('t1', 'side', 'u2');
    await p.fixture.whenStable();
    await p.user.click(composer()!);
    within(dock()).getByRole('button', { name: 'from “A particle.”' });
    const askFrom = vi.spyOn(p.store, 'askFrom').mockResolvedValue(branch('lumps'));
    await p.user.type(composer()!, 'How big?{Control>}{Enter}{/Control}');
    expect(askFrom).toHaveBeenCalledWith('a2', 'How big?', null);
  });

  it('a new conversation, or a reply that failed, has nothing to go on a tangent from: Send', async () => {
    const p = await page({ d: detail([], [branch('trunk', { title: 'Main thread' })]) });
    expect(composer()?.placeholder).toBe('Start the conversation…');
    expect(within(dock()).queryByRole('button', { name: /^(Tangent|Next)$/ })).toBeNull();
    const send = vi.spyOn(p.store, 'send').mockResolvedValue(true);
    await p.user.type(composer()!, 'Light?{Enter}');
    expect(send).toHaveBeenCalledWith('trunk', 'Light?');

    const failed = tree();
    failed.nodes = failed.nodes.map((n) => (n.id === 'a1' ? { ...n, status: 'error' } : n));
    p.store.detail.set(failed);
    await p.fixture.whenStable();
    expect(composer()?.placeholder).toBe('Ask anything…');
    within(dock()).getByRole('button', { name: 'Send message' });
  });

  it('Tangent ↳’s caret sets the tangent up from the composer’s target, with the typed question', async () => {
    const p = await page({ d: branchy() });
    await p.user.type(composer()!, 'Why so?');
    await p.user.click(within(dock()).getByRole('button', { name: 'Tangent with options…' }));
    expect(p.ui.dialogs.get('branch')).toEqual({
      kind: 'branch',
      fromNodeId: 'a1',
      quote: null,
      message: 'Why so?',
    });
    p.ui.dialogs.close('branch');
    // With words on the box, Ctrl+Shift+Enter: their quote goes along.
    selectWave();
    await p.fixture.whenStable();
    await p.user.click(screen.getByRole('button', { name: 'Ask about this' }));
    await p.user.keyboard('{Control>}{Shift>}{Enter}{/Shift}{/Control}');
    expect(p.ui.dialogs.get('branch')).toEqual({
      kind: 'branch',
      fromNodeId: 'a1',
      quote: 'wave',
      message: 'Why so?',
    });
    // Nothing is sent from the box, which keeps the question until the tangent's first message is in.
    expect(composer()?.value).toBe('Why so?');
    TestBed.inject(ComposerController).sent('new', 'Why so?');
    await p.fixture.whenStable();
    expect(composer()?.value).toBe('');
  });

  it('every tangent opens at its start, after the main thread was read to its end', async () => {
    const p = await page({ d: branchy() });
    // The open tangent's fork 1200px down a 3000px conversation, in a 500px view.
    const view = layOutThread({ height: 3000, view: 500, at: { '.fork-current': 1200 } });
    view.scrollBy(3000);
    for (const [tangent, first] of [
      ['side', 'u2'],
      ['other', 'u3'],
      ['side', 'u2'],
    ] as const) {
      p.store.setRoute('t1', tangent, first);
      await vi.waitFor(() => expect(view.scrollTop).toBe(1200));
      // The main thread opens at its end.
      p.store.setRoute('t1', null, null);
      await vi.waitFor(() => expect(view.scrollTop).toBe(2500));
    }
  });

  it('a tangent whose reply is still being written opens at its start too', async () => {
    const d = branchy();
    d.nodes = d.nodes.map((n) => (n.id === 'a2' ? { ...n, status: 'streaming', content: '' } : n));
    const p = await page({ d });
    const view = layOutThread({ height: 3000, view: 500, at: { '.fork-current': 1200 } });
    view.scrollBy(3000);
    p.store.setRoute('t1', 'side', 'u2');
    await vi.waitFor(() => expect(view.scrollTop).toBe(1200));
    p.store.live.set(
      new Map([
        [
          'a2',
          {
            nodeId: 'a2',
            treeId: 't1',
            branchId: 'side',
            content: 'A particle',
            status: null,
            reconnecting: false,
          },
        ],
      ]),
    );
    await p.fixture.whenStable();
    await new Promise(requestAnimationFrame);
    expect(view.scrollTop).toBe(1200);
  });

  it('from a tangent’s start, the down arrow jumps to its end, and goes once there', async () => {
    const p = await page({ d: branchy() });
    const view = layOutThread({ height: 3000, view: 500, at: { '.fork-current': 1200 } });
    const jump = () => screen.getByRole('button', { name: 'Jump to the end' });
    view.scrollBy(3000);
    await p.fixture.whenStable();
    expect(jump().hasAttribute('inert')).toBe(true);
    p.store.setRoute('t1', 'side', 'u2');
    await vi.waitFor(() => expect(view.scrollTop).toBe(1200));
    await p.fixture.whenStable();
    expect(jump().hasAttribute('inert')).toBe(false);
    await p.user.click(jump());
    expect(view.scrollTop).toBe(2500);
    await p.fixture.whenStable();
    expect(jump().hasAttribute('inert')).toBe(true);
  });

  it('the title, and the open thread’s step in the path, go back to its start', async () => {
    const p = await page({ d: branchy() });
    const view = layOutThread({ height: 3000, view: 500, at: { '.fork-current': 1200 } });
    view.scrollBy(3000);
    const path = () => screen.getByRole('navigation', { name: 'Tangent path' });
    const main = within(path()).getByRole('button', { name: 'Main thread' });
    expect(main.getAttribute('aria-current')).toBe('page');
    expect(main.title).toBe('Back to the start');
    await p.user.click(main);
    await vi.waitFor(() => expect(view.scrollTop).toBe(0));

    p.store.setRoute('t1', 'side', 'u2');
    await vi.waitFor(() => expect(view.scrollTop).toBe(1200));
    view.scrollBy(800);
    const title = within(screen.getByRole('heading', { name: 'Light' })).getByRole('button');
    expect(title.title).toBe('Back to the start');
    await p.user.click(title);
    await vi.waitFor(() => expect(view.scrollTop).toBe(1200));
    view.scrollBy(800);
    const current = within(path()).getByRole('button', { name: 'Particles' });
    expect(current.title).toBe('Back to the start of this tangent');
    await p.user.click(current);
    await vi.waitFor(() => expect(view.scrollTop).toBe(1200));
  });

  it('a new tangent shows where it starts, and asks for its first question', async () => {
    const p = await page({ branchId: 'side' });
    expect(screen.getByText('New tangent. Your next message starts it.')).toBeTruthy();
    expect(screen.getByText('A wave', { selector: 'blockquote' })).toBeTruthy();
    expect(composer()?.placeholder).toBe('Ask your tangent…');
    expect(within(dock()).queryByRole('button', { name: /^(Tangent|Next)$/ })).toBeNull();
    const send = vi.spyOn(p.store, 'send').mockResolvedValue(true);
    await p.user.type(composer()!, 'Why credit?{Enter}');
    expect(send).toHaveBeenCalledWith('side', 'Why credit?');
  });

  it('"Ask about this" puts the words on the composer; the tangent is made when it is sent', async () => {
    const p = await page();
    const startBranch = vi.spyOn(p.store, 'startBranch');
    selectWave();
    await p.fixture.whenStable();
    await p.user.click(screen.getByRole('button', { name: 'Ask about this' }));
    // Nothing is made until the question is sent.
    expect(startBranch).not.toHaveBeenCalled();
    expect(screen.getByText('“wave”')).toBeTruthy();
    expect(composer()?.placeholder).toBe('Ask about this…');
    // Words to ask about only go on a tangent, and Compare waits.
    within(dock()).getByRole('button', { name: 'Tangent' });
    expect(within(dock()).queryByRole('button', { name: 'Next' })).toBeNull();
    expect(within(dock()).queryByRole('button', { name: 'Compare Normal and Max' })).toBeNull();
    expect(document.activeElement).toBe(composer());
    const askFrom = vi.spyOn(p.store, 'askFrom').mockResolvedValue(branch('new'));
    await p.user.type(composer()!, 'Of what?{Enter}');
    expect(askFrom).toHaveBeenCalledWith('a1', 'Of what?', 'wave');
    await p.fixture.whenStable();
    expect(screen.queryByText('“wave”')).toBeNull();
  });

  it('a quote dropped from the composer leaves nothing behind', async () => {
    const p = await page();
    const startBranch = vi.spyOn(p.store, 'startBranch');
    selectWave();
    await p.fixture.whenStable();
    await p.user.click(screen.getByRole('button', { name: 'Ask about this' }));
    await p.user.click(screen.getByRole('button', { name: 'Don’t ask about “wave”' }));
    expect(screen.queryByText('“wave”')).toBeNull();
    expect(composer()?.placeholder).toBe('Ask anything…');
    const send = vi.spyOn(p.store, 'send').mockResolvedValue(true);
    await p.user.type(composer()!, 'And?{Control>}{Enter}{/Control}');
    expect(send).toHaveBeenCalledWith('trunk', 'And?');
    expect(startBranch).not.toHaveBeenCalled();
  });

  it("a message's own Tangent ↳ puts it on the composer; the tangent is made when it is sent", async () => {
    const p = await page();
    const startBranch = vi.spyOn(p.store, 'startBranch');
    await p.user.click(tangentOf('a1'));
    expect(startBranch).not.toHaveBeenCalled();
    within(dock()).getByText('Tangent from “A wave.”');
    expect(composer()?.placeholder).toBe('Ask about this…');
    expect(document.activeElement).toBe(composer());
    within(dock()).getByRole('button', { name: 'Tangent' });
    expect(within(dock()).queryByRole('button', { name: 'Next' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Compare Normal and Max' })).toBeNull();
    // Dropped, it leaves nothing behind.
    await p.user.click(within(dock()).getByRole('button', { name: 'Don’t go on this tangent' }));
    expect(within(dock()).queryByText(/Tangent from/)).toBeNull();
    expect(composer()?.placeholder).toBe('Ask anything…');
    // Asked, the tangent starts with the question, about the whole message.
    await p.user.click(tangentOf('a1'));
    const askFrom = vi.spyOn(p.store, 'askFrom').mockResolvedValue(branch('new'));
    await p.user.type(composer()!, 'Of what?{Enter}');
    expect(askFrom).toHaveBeenCalledWith('a1', 'Of what?', null);
    await p.fixture.whenStable();
    expect(within(dock()).queryByText(/Tangent from/)).toBeNull();
  });

  it('a message deleted from under the composer goes off it, as it does when the page goes', async () => {
    const d = tree();
    d.nodes.push(
      node('u2', { parentId: 'a1', seq: 2, role: 'user', content: 'Of what?' }),
      node('a2', { parentId: 'u2', seq: 3, content: 'Of fields.' }),
    );
    const p = await page({ d });
    await p.user.click(tangentOf('a2'));
    within(dock()).getByText('Tangent from “Of fields.”');
    Object.assign(TestBed.inject(ApiClient), {
      deleteMessage: vi.fn(async () => ({ treeId: 't1', branchIds: [], nodeIds: ['u2', 'a2'] })),
    });
    await p.store.deleteMessage('u2');
    await p.fixture.whenStable();
    expect(within(dock()).queryByText(/Tangent from/)).toBeNull();
    expect(composer()?.placeholder).toBe('Ask anything…');

    await p.user.click(tangentOf('a1'));
    const lead = TestBed.inject(ComposerController).lead;
    expect(lead()).toEqual({ nodeId: 'a1', quote: null });
    p.fixture.destroy();
    expect(lead()).toBeNull();
  });

  it('the header names the open thread: the main thread is not called a tangent', async () => {
    await page();
    expect(screen.getByRole('button', { name: /^Link the main thread/ })).toBeTruthy();
    expect(screen.getByTitle('Main thread settings')).toBeTruthy();
    expect(
      screen.queryByText(/tangent/i, { selector: '.chat-head button, .chat-head span' }),
    ).toBeNull();
  });

  it('on a narrow screen, where only their icons show, the header’s buttons keep their names', async () => {
    const p = await page({ branchId: 'side' });
    const header = p.host.querySelector<HTMLElement>('.chat-head')!;
    // What .hide-narrow does below 860px (layout.css).
    for (const text of header.querySelectorAll<HTMLElement>('.hide-narrow'))
      text.style.display = 'none';
    expect(within(header).queryAllByRole('button', { name: (name) => !name.trim() })).toEqual([]);
    for (const name of ['Tangent settings', 'Share…', 'Export', 'Conversation settings'])
      expect(within(header).getByRole('button', { name })).toBeTruthy();
  });

  it('inside a tangent the header says tangent', async () => {
    await page({ branchId: 'side' });
    expect(screen.getByRole('button', { name: /^Link this tangent/ })).toBeTruthy();
    expect(screen.getByTitle('Tangent settings')).toBeTruthy();
  });

  it('while a reply streams, the box is disabled and Stop stops it', async () => {
    const p = await page();
    p.store.detail.set(
      detail(
        [
          node('u1', { role: 'user', content: 'What is light?' }),
          node('a1', { parentId: 'u1', seq: 1, content: '', status: 'streaming' }),
        ],
        [branch('trunk', { title: 'Main thread' })],
      ),
    );
    await p.fixture.whenStable();
    expect(composer()?.disabled).toBe(true);
    const cancel = vi.spyOn(p.store, 'cancel').mockResolvedValue(undefined);
    await p.user.click(screen.getByRole('button', { name: 'Stop generating' }));
    expect(cancel).toHaveBeenCalledWith('a1');
  });

  it('on a branch the membership locks, the composer is the read-only notice', async () => {
    const p = await page({ lapsed: true });
    expect(composer()).toBeNull();
    screen.getByRole('region', { name: 'Your membership has ended.' });
    const toCredit = vi.spyOn(p.store, 'switchToCredit').mockResolvedValue(true);
    await p.user.click(screen.getByRole('button', { name: 'Continue with Tangent credit' }));
    expect(toCredit).toHaveBeenCalledWith('trunk');
  });

  it('the credit branch of the same conversation keeps its composer', async () => {
    await page({ lapsed: true, branchId: 'side' });
    expect(composer()).not.toBeNull();
  });

  it('on a read-only tangent, which has no message box, words of the thread above open Tangent from here', async () => {
    // The main thread on Tangent credit; the open tangent off it on the lapsed own key.
    const d = tree();
    d.branches = [
      branch('trunk', { title: 'Main thread', funding: 'credit' }),
      branch('side', { parentBranchId: 'trunk', branchPointNodeId: 'a1', title: 'Own key' }),
    ];
    const p = await page({ d, lapsed: true, branchId: 'side' });
    expect(composer()).toBeNull();
    selectWave();
    await p.fixture.whenStable();
    await p.user.click(screen.getByRole('button', { name: 'Tangent from this selection…' }));
    expect(p.ui.dialogs.get('branch')).toEqual({ kind: 'branch', fromNodeId: 'a1', quote: 'wave' });
    expect(TestBed.inject(ComposerController).lead()).toBeNull();
  });

  it('from a tangent that can reply, words of a locked thread above go on its message box', async () => {
    // The main thread on the lapsed own key; the open tangent on Tangent credit, where the tangent starts.
    const p = await page({ lapsed: true, branchId: 'side' });
    selectWave();
    await p.fixture.whenStable();
    await p.user.click(screen.getByRole('button', { name: 'Ask about this' }));
    expect(p.ui.dialogs.list()).toEqual([]);
    expect(screen.getByText('“wave”')).toBeTruthy();
    const askFrom = vi.spyOn(p.store, 'askFrom').mockResolvedValue(branch('new'));
    await p.user.type(composer()!, 'Of what?{Enter}');
    expect(askFrom).toHaveBeenCalledWith('a1', 'Of what?', 'wave');
  });

  it('in pick mode, a banner says what is being linked, and Cancel leaves it', async () => {
    const p = await page();
    p.ui.linkPick.set({ fromNodeId: 'a1' });
    await p.fixture.whenStable();
    const banner = screen
      .getByText(/Choose the message that relates to/)
      .closest<HTMLElement>('[role=status]')!;
    expect(banner.textContent).toContain('A wave.');
    await p.user.click(within(banner).getByRole('button', { name: 'Cancel (Esc)' }));
    expect(p.ui.linkPick()).toBeNull();
  });

  it('a conversation that can’t be opened says why, with the way back', async () => {
    const p = await page({ d: null });
    p.store.detailError.set('Conversation not found');
    await p.fixture.whenStable();
    screen.getByRole('heading', { name: 'Can’t open this conversation' });
    expect(screen.getByText('Conversation not found')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to conversations' }).getAttribute('href')).toBe(
      '/',
    );
  });
});
