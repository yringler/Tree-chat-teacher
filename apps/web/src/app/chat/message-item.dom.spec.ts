import { TestBed } from '@angular/core/testing';
import { CONTINUE_MESSAGE, type ChatNode, type TreeDetail } from '@tangent/shared';
import { ToastStore } from '@tangent/web-shared';
import {
  branch,
  detail,
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
import { MessageItem } from './message-item';

const REPLY = [
  'Light is a wave.',
  '',
  '<tangents>',
  '- [continue] Diffraction — what a slit does to it next',
  '- [tangent] Interference — why two waves add up',
  '- Photons',
  '</tangents>',
].join('\n');

/**
 * "What is light?" (u1) and its reply (a1) on `trunk`, which suggests one
 * next step and two tangents (one of them untagged).
 */
function tree(reply: Partial<ChatNode> = {}, extra: Partial<TreeDetail> = {}): TreeDetail {
  return detail(
    [
      node('u1', { role: 'user', content: 'What is light?' }),
      node('a1', { parentId: 'u1', seq: 1, content: REPLY, model: 'a/b', ...reply }),
      ...(extra.nodes ?? []),
    ],
    [branch('trunk', { title: 'Main thread' }), ...(extra.branches ?? [])],
  );
}

const LAPSED = membership({ status: 'inactive', subscriptionStatus: 'canceled' });
const CREDIT = provider({ funding: 'credit', acceptsUserKey: false, keySource: 'server' });

/**
 * Message `nodeId` of `d`, as power renders it. `lapsed`: the user's
 * membership ended, so the own-key trunk is read-only; `credit`: Tangent
 * credit can still generate.
 */
async function message(
  nodeId: string,
  opts: { d?: TreeDetail; lapsed?: boolean; credit?: boolean } = {},
) {
  const d = opts.d ?? tree();
  const r = await render(MessageItem, {
    providers: powerProviders(TreeStore, {}),
    setup: () => {
      const store = TestBed.inject(TreeStore);
      signIn(store.account, {
        membership: opts.lapsed ? LAPSED : undefined,
        providers: opts.credit ? [provider(), CREDIT] : [provider()],
        builtInCredit: opts.credit,
        billing: opts.credit ? ({ availableMicros: 1_000_000, enabled: true } as never) : undefined,
      });
      openTree(store, d);
    },
    inputs: { node: d.nodes.find((n) => n.id === nodeId) },
  });
  return {
    ...r,
    store: TestBed.inject(TreeStore),
    ui: TestBed.inject(UiStore),
    user: userEvent.setup(),
  };
}

const button = (name: string | RegExp) => screen.getByRole<HTMLButtonElement>('button', { name });
const names = () =>
  screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim());

describe('MessageItem: a finished reply', () => {
  it('says who wrote it and shows its text, never the tangents block', async () => {
    await message('a1');
    const article = screen.getByRole('article');
    expect(within(article).getByText('Assistant')).toBeTruthy();
    expect(within(article).getByText('a/b')).toBeTruthy();
    expect(within(article).getByText('Light is a wave.')).toBeTruthy();
    expect(article.textContent).not.toContain('<tangents>');
  });

  it('offers Tangent ↳, Review, Link and Copy', async () => {
    await message('a1');
    for (const name of ['Tangent ↳', 'Review', 'Link…', 'Copy message']) button(name);
  });

  it('Tangent ↳ opens the tangent dialog on it', async () => {
    const m = await message('a1');
    await m.user.click(button('Tangent ↳'));
    expect(m.ui.dialogs.get('branch')).toEqual({ kind: 'branch', fromNodeId: 'a1', quote: null });
  });

  it('Copy copies the reply without its tangents, and says so', async () => {
    // user-event stands in for the clipboard.
    const m = await message('a1');
    await m.user.click(button('Copy message'));
    expect(await navigator.clipboard.readText()).toBe('Light is a wave.');
    await vi.waitFor(() => button('Copied'));
    expect(TestBed.inject(ToastStore).toasts()[0]?.text).toBe('Copied to clipboard');
  });

  it('a question has no Review', async () => {
    await message('u1');
    expect(screen.getByRole('article').textContent).toContain('You');
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
    button('Tangent ↳');
  });

  it('with nothing left to generate on, offers no new branch, review or question; links stay', async () => {
    await message('a1', { lapsed: true });
    expect(names()).not.toContain('Tangent ↳');
    expect(names()).not.toContain('Review');
    expect(screen.queryByRole('textbox', { name: /Ask your own/ })).toBeNull();
    button('Link…');
    button('Copy message');
  });
});

const group = (name: string) => screen.getByRole('navigation', { name });

describe('TangentNav: Keep going and Tangents', () => {
  it('splits the suggestions into Keep going and Tangents; an untagged one is a tangent', async () => {
    await message('a1');
    const next = within(group('Keep going'));
    expect(next.getAllByRole('button')).toHaveLength(1);
    next.getByRole('button', { name: /^Diffraction/ });
    const side = within(group('Tangents'));
    side.getByRole('button', { name: /^Interference/ });
    side.getByRole('button', { name: 'Photons' });
    // "Ask your own" stays last, among the tangents.
    side.getByRole('textbox', { name: 'Ask your own question in a new tangent' });
  });

  it('a Keep going step is sent as the next message here', async () => {
    const m = await message('a1');
    const continueWith = vi.spyOn(m.store, 'continueWith').mockResolvedValue(true);
    const step = within(group('Keep going')).getByRole<HTMLButtonElement>('button', {
      name: /^Diffraction/,
    });
    expect(step.title).toBe('Got it, what’s next? Keeps the main lesson moving.');
    await m.user.click(step);
    expect(continueWith).toHaveBeenCalledWith('a1', 'Diffraction');
  });

  it('Keep going shows only on the latest reply; older ones keep their tangents', async () => {
    const d = tree(
      {},
      {
        nodes: [
          node('u2', { role: 'user', parentId: 'a1', seq: 2, content: 'And then?' }),
          node('a2', { parentId: 'u2', seq: 3, content: 'Then it spreads.' }),
        ],
      },
    );
    await message('a1', { d });
    expect(screen.queryByRole('navigation', { name: 'Keep going' })).toBeNull();
    within(group('Tangents')).getByRole('button', { name: /^Interference/ });
  });

  it('each tangent is a tangent to follow', async () => {
    const m = await message('a1');
    const follow = vi.spyOn(m.store, 'followTangent').mockResolvedValue(null);
    await m.user.click(within(group('Tangents')).getByRole('button', { name: /^Interference/ }));
    expect(follow).toHaveBeenCalledWith('a1', 'Interference');
  });

  it('asks your own question in a new tangent, emptying the field once asked', async () => {
    const m = await message('a1');
    const askFrom = vi.spyOn(m.store, 'askFrom').mockResolvedValue(branch('new'));
    const field = screen.getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Ask your own question in a new tangent',
    });
    await m.user.type(field, 'Why does it bend?');
    await m.user.click(button('Ask'));
    expect(askFrom).toHaveBeenCalledWith('a1', 'Why does it bend?');
    await vi.waitFor(() => expect(field.value).toBe(''));
  });

  it('on a thread the membership locks, suggestions are disabled and say why; one followed still opens', async () => {
    const d = tree(
      {},
      {
        branches: [
          branch('photons', {
            parentBranchId: 'trunk',
            branchPointNodeId: 'a1',
            title: 'Photons',
            funding: 'credit',
          }),
        ],
      },
    );
    await message('a1', { d, lapsed: true, credit: true });
    const step = button(/^Diffraction/);
    expect(step.disabled).toBe(true);
    expect(step.title).toBe('Continuing needs a membership (this thread is on your own key)');
    const interference = button(/^Interference/);
    expect(interference.disabled).toBe(true);
    expect(interference.title).toBe(
      'Starting a tangent needs a membership (this thread is on your own key)',
    );
    const photons = within(group('Tangents')).getByRole<HTMLButtonElement>('button', {
      name: 'Photons',
    });
    expect(photons.disabled).toBe(false);
    expect(photons.title).toBe('Open tangent');
    expect(
      screen.getByRole<HTMLTextAreaElement>('textbox', { name: /Ask your own/ }).disabled,
    ).toBe(true);
  });

  it('a reply still being written offers no suggestions yet', async () => {
    await message('a1', { d: tree({ status: 'streaming', content: 'Light is' }) });
    expect(screen.queryByRole('navigation', { name: 'Keep going' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Tangents' })).toBeNull();
    expect(screen.getByText('Generating…')).toBeTruthy();
  });
});

describe('MessageStatus: a reply that is not whole', () => {
  const cutOff = {
    status: 'error',
    errorKind: 'cut_off',
    error: 'It hit the reply length limit.',
  } as const;

  it('cut off at its length limit: says so, and Continue asks for the rest', async () => {
    const m = await message('a1', { d: tree(cutOff) });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Cut off.');
    expect(alert.textContent).toContain('It hit the reply length limit.');
    expect(alert.textContent).not.toContain('The reply failed.');
    const send = vi.spyOn(m.store, 'send').mockResolvedValue(true);
    await m.user.click(within(alert).getByRole('button', { name: 'Continue' }));
    expect(send).toHaveBeenCalledWith('trunk', CONTINUE_MESSAGE);
  });

  it('no Continue while the branch is busy, or locked: it says how to get the rest', async () => {
    const m = await message('a1', { d: tree(cutOff) });
    m.store.sending.set(new Set(['trunk']));
    await m.fixture.whenStable();
    const alert = screen.getByRole('alert');
    expect(within(alert).queryByRole('button')).toBeNull();
    expect(alert.textContent).toContain('ask the model to continue');
  });

  it('a locked branch offers no Continue', async () => {
    await message('a1', { d: tree(cutOff), lapsed: true, credit: true });
    expect(within(screen.getByRole('alert')).queryByRole('button')).toBeNull();
  });

  it('failed: says so with the error; stopped: says only that', async () => {
    const m = await message('a1', {
      d: tree({ status: 'error', errorKind: 'provider', error: 'Rate limited.' }),
    });
    expect(screen.getByRole('alert').textContent).toContain('The reply failed.');
    expect(screen.getByRole('alert').textContent).toContain('Rate limited.');
    await m.set({
      node: node('a1', { status: 'error', errorKind: 'cancelled', error: 'Stopped by you' }),
    });
    expect(screen.getByRole('alert').textContent).toContain('Stopped.');
    expect(screen.getByRole('alert').textContent).not.toContain('Stopped by you');
  });
});

describe('MessageActions in pick mode', () => {
  it('"Link here" links this message to the one linked from', async () => {
    const m = await message('a1');
    const createLink = vi.spyOn(m.store, 'createLink').mockResolvedValue(null);
    m.ui.linkPick.set({ fromNodeId: 'u1' });
    await m.fixture.whenStable();
    expect(screen.queryByRole('button', { name: 'Tangent ↳' })).toBeNull();
    await m.user.click(button('Link here'));
    expect(createLink).toHaveBeenCalledWith('u1', 'a1');
    expect(m.ui.linkPick()).toBeNull();
  });

  it('the message linked from cannot be picked', async () => {
    const m = await message('u1');
    m.ui.linkPick.set({ fromNodeId: 'u1' });
    await m.fixture.whenStable();
    expect(button('Linking from here').disabled).toBe(true);
  });
});
