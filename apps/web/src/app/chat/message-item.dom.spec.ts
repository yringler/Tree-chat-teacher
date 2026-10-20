import { TestBed } from '@angular/core/testing';
import { CONTINUE_MESSAGE, type ChatNode, type TreeDetail } from '@tangent/shared';
import { ComposerController, ToastStore } from '@tangent/web-shared';
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
  '- [deeper] Diffraction — what a slit does to it next',
  '- [tangent] Interference — why two waves add up',
  '- Photons',
  '</tangents>',
].join('\n');

/**
 * "What is light?" (u1) and its reply (a1) on `trunk`, which suggests one
 * question to dig deeper into and two tangents (one of them untagged).
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
 * Message `nodeId` of `d`, as power renders it, with `branchId` open (the
 * trunk by default). `lapsed`: the user's membership ended, so the own-key
 * trunk is read-only; `credit`: Tangent credit can still generate.
 */
async function message(
  nodeId: string,
  opts: { d?: TreeDetail; lapsed?: boolean; credit?: boolean; branchId?: string } = {},
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
      openTree(store, d, opts.branchId ?? null);
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

  it('offers Tangent ↳, Review, Link and Copy, but no Delete', async () => {
    await message('a1');
    for (const name of ['Tangent ↳', 'Review', 'Link…', 'Copy message']) button(name);
    expect(screen.queryByRole('button', { name: 'Delete message' })).toBeNull();
  });

  it('Tangent ↳ puts it on the message box, and says so', async () => {
    const m = await message('a1');
    const tangent = button('Tangent ↳');
    expect(tangent.title).toBe('Tangent from here: put this message on the message box (b)');
    expect(tangent.hasAttribute('aria-haspopup')).toBe(false);
    await m.user.click(tangent);
    expect(TestBed.inject(ComposerController).lead()).toEqual({ nodeId: 'a1', quote: null });
    expect(m.ui.dialogs.list()).toEqual([]);
  });

  it('Tangent ↳ with words of it selected puts those words on the message box', async () => {
    const m = await message('a1');
    const text = screen.getByText('Light is a wave.').firstChild!;
    const range = document.createRange();
    range.setStart(text, 11);
    range.setEnd(text, 15);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    await m.user.click(button('Tangent ↳'));
    expect(TestBed.inject(ComposerController).lead()).toEqual({ nodeId: 'a1', quote: 'wave' });
    expect(window.getSelection()!.isCollapsed).toBe(true);
  });

  it('on a read-only thread, which has no message box, Tangent ↳ opens Tangent from here, and says so', async () => {
    const m = await message('a1', { lapsed: true, credit: true });
    const tangent = button('Tangent ↳');
    expect(tangent.title).toBe('Tangent from here: set up a tangent from this message (b)');
    expect(tangent.getAttribute('aria-haspopup')).toBe('dialog');
    await m.user.click(tangent);
    expect(m.ui.dialogs.get('branch')).toEqual({ kind: 'branch', fromNodeId: 'a1', quote: null });
    expect(TestBed.inject(ComposerController).lead()).toBeNull();
  });

  it('Copy copies the reply without its tangents, and says so', async () => {
    // user-event stands in for the clipboard.
    const m = await message('a1');
    await m.user.click(button('Copy message'));
    expect(await navigator.clipboard.readText()).toBe('Light is a wave.');
    await vi.waitFor(() => button('Copied'));
    expect(TestBed.inject(ToastStore).toasts()[0]?.text).toBe('Copied to clipboard');
  });

  it('a question deletes, with what follows it, once the user says so', async () => {
    const m = await message('u1');
    const del = vi.spyOn(m.store, 'deleteMessage').mockResolvedValue(true);
    const ask = vi.fn(() => false);
    vi.stubGlobal('confirm', ask);
    try {
      await m.user.click(button('Delete message'));
      expect(ask).toHaveBeenCalledWith(
        expect.stringMatching(
          /^Delete this message\? Everything after it goes too: 1 later message\./,
        ),
      );
      expect(del).not.toHaveBeenCalled();
      ask.mockReturnValue(true);
      await m.user.click(button('Delete message'));
      expect(del).toHaveBeenCalledWith('u1');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a question has no Review', async () => {
    await message('u1');
    expect(screen.getByRole('article').textContent).toContain('You');
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
    button('Tangent ↳');
  });

  it('with nothing left to generate on, offers no new branch or review; links stay', async () => {
    await message('a1', { lapsed: true });
    expect(names()).not.toContain('Tangent ↳');
    expect(names()).not.toContain('Review');
    button('Link…');
    button('Copy message');
  });
});

const group = (name: string) => screen.getByRole('group', { name });
const start = (title: string) => new RegExp(`^Start a tangent: ${title}`);

describe('TangentNav: Dig deeper and Suggested tangents', () => {
  it('splits the suggestions into Dig deeper and Suggested tangents; an untagged one is a tangent', async () => {
    await message('a1');
    const deeper = within(group('Dig deeper'));
    expect(deeper.getAllByRole('button')).toHaveLength(1);
    deeper.getByRole('button', { name: start('Diffraction') });
    const side = within(group('Suggested tangents'));
    side.getByRole('button', { name: start('Interference') });
    side.getByRole('button', { name: 'Start a tangent: Photons' });
    // A question of the user's own goes in the message box, not in a field here.
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('Dig deeper shows on an older reply too, and opens a tangent', async () => {
    const d = tree(
      {},
      {
        nodes: [
          node('u2', { role: 'user', parentId: 'a1', seq: 2, content: 'And then?' }),
          node('a2', { parentId: 'u2', seq: 3, content: 'Then it spreads.' }),
        ],
      },
    );
    const m = await message('a1', { d });
    const follow = vi.spyOn(m.store, 'followTangent').mockResolvedValue(null);
    await m.user.click(
      within(group('Dig deeper')).getByRole('button', { name: start('Diffraction') }),
    );
    expect(follow).toHaveBeenCalledWith('a1', 'Diffraction');
  });

  it('each tangent is a tangent to follow', async () => {
    const m = await message('a1');
    const follow = vi.spyOn(m.store, 'followTangent').mockResolvedValue(null);
    await m.user.click(
      within(group('Suggested tangents')).getByRole('button', { name: start('Interference') }),
    );
    expect(follow).toHaveBeenCalledWith('a1', 'Interference');
  });

  it('on a thread the membership locks, suggestions fold and say why; one followed still opens', async () => {
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
    const m = await message('a1', { d, lapsed: true, credit: true });
    const why = 'Starting a tangent needs a membership (this thread is on your own key)';
    const more = button('2 more suggested');
    expect(more.title).toBe(why);
    await m.user.click(more);
    const diffraction = button(start('Diffraction'));
    expect(diffraction.disabled).toBe(true);
    expect(diffraction.title).toBe(why);
    const interference = button(start('Interference'));
    expect(interference.disabled).toBe(true);
    expect(interference.title).toBe(why);
    const photons = within(group('Your tangents')).getByRole<HTMLButtonElement>('button', {
      name: /^Open tangent: Photons/,
    });
    expect(photons.disabled).toBe(false);
  });

  it('from a tangent that can reply, a locked thread’s reply above offers its suggestions', async () => {
    // The main thread on the lapsed own key; the open tangent, off a later reply, on Tangent credit.
    const d = tree(
      {},
      {
        nodes: [
          node('u2', { role: 'user', parentId: 'a1', seq: 2, content: 'And then?' }),
          node('a2', { parentId: 'u2', seq: 3, content: 'Then it spreads.' }),
        ],
        branches: [
          branch('side', {
            parentBranchId: 'trunk',
            branchPointNodeId: 'a2',
            title: 'Spreading',
            funding: 'credit',
          }),
        ],
      },
    );
    const m = await message('a1', { d, lapsed: true, credit: true, branchId: 'side' });
    const diffraction = within(group('Dig deeper')).getByRole<HTMLButtonElement>('button', {
      name: start('Diffraction'),
    });
    expect(diffraction.disabled).toBe(false);
    const follow = vi.spyOn(m.store, 'followTangent').mockResolvedValue(null);
    await m.user.click(diffraction);
    expect(follow).toHaveBeenCalledWith('a1', 'Diffraction');
  });

  it('a reply still being written offers no suggestions yet', async () => {
    await message('a1', { d: tree({ status: 'streaming', content: 'Light is' }) });
    expect(screen.queryByRole('group', { name: 'Dig deeper' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Suggested tangents' })).toBeNull();
    expect(screen.getByText('Generating…')).toBeTruthy();
  });
});

/** Tangents from `from`: "Optics" (a summary, private, with two messages) and "Colour". */
function withTangents(from: string, reply: Partial<ChatNode> = {}): TreeDetail {
  return tree(reply, {
    branches: [
      branch('optics', {
        parentBranchId: 'trunk',
        branchPointNodeId: from,
        title: 'Optics',
        contextMode: 'summary',
        isPrivate: true,
      }),
      branch('colour', { parentBranchId: 'trunk', branchPointNodeId: from, title: 'Colour' }),
    ],
    nodes: [
      node('o1', { branchId: 'optics', parentId: from, seq: 2, role: 'user', content: 'Lenses?' }),
      node('o2', { branchId: 'optics', parentId: 'o1', seq: 3, content: 'They bend light.' }),
    ],
  });
}

describe('TangentNav: Your tangents', () => {
  it('lists the tangents from a question too, with their mode, privacy and size', async () => {
    const m = await message('u1', { d: withTangents('u1') });
    const yours = within(group('Your tangents'));
    const optics = yours.getByRole('button', { name: /^Open tangent: Optics/ });
    const colour = yours.getByRole('button', { name: /^Open tangent: Colour/ });
    expect(optics.querySelector('.mode-summary')).not.toBeNull();
    expect(optics.querySelector('app-icon[name="lock"]')).not.toBeNull();
    expect(colour.querySelector('app-icon[name="lock"]')).toBeNull();
    expect(optics.querySelector('.count')?.textContent).toBe('2');
    expect(colour.querySelector('.count')?.textContent).toBe('0');
    expect(screen.queryByRole('group', { name: 'Suggested tangents' })).toBeNull();
    const go = vi.spyOn(m.store, 'go').mockImplementation(() => undefined);
    await m.user.click(optics);
    expect(go).toHaveBeenCalledWith('optics', 'o1');
  });

  it('lists the tangents from a failed reply', async () => {
    await message('a1', {
      d: withTangents('a1', { status: 'error', errorKind: 'provider', error: 'Rate limited.' }),
    });
    within(group('Your tangents')).getByRole('button', { name: /^Open tangent: Optics/ });
  });

  it('deletes one from here, once the user says so', async () => {
    const m = await message('u1', { d: withTangents('u1') });
    const del = vi.spyOn(m.store, 'deleteBranch').mockResolvedValue(true);
    const ask = vi.fn(() => false);
    vi.stubGlobal('confirm', ask);
    try {
      const trash = button('Delete the tangent Colour');
      await m.user.click(trash);
      expect(ask).toHaveBeenCalledWith(expect.stringMatching(/^Delete “Colour”/));
      expect(del).not.toHaveBeenCalled();
      ask.mockReturnValue(true);
      await m.user.click(trash);
      expect(del).toHaveBeenCalledWith('colour');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('back from one, it is lit', async () => {
    const m = await message('a1', { d: withTangents('a1') });
    m.store.setRoute('t1', 'optics', null);
    m.store.setRoute('t1', null, 'a1');
    await m.fixture.whenStable();
    const optics = button(/^Open tangent: Optics \(you were just here\)/);
    expect(optics.closest('.tangent-yours')?.classList).toContain('is-back');
  });

  it('one on the selected branch’s chain is lit and current', async () => {
    const r = await message('a1', { d: withTangents('a1') });
    await r.set({ chainIds: new Set(['trunk', 'colour']) });
    const colour = button(/^Open tangent: Colour/);
    expect(colour.getAttribute('aria-current')).toBe('true');
    expect(button(/^Open tangent: Optics/).getAttribute('aria-current')).toBeNull();
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
    expect(within(alert).queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(alert.textContent).toContain('ask the model to continue');
    // And where the limit is raised: Settings, opened there.
    await m.user.click(within(alert).getByRole('button', { name: 'Settings → Reply limit' }));
    expect(m.ui.dialogs.list()).toEqual([{ kind: 'settings', section: 'output-cap' }]);
  });

  it('a locked branch offers no Continue', async () => {
    await message('a1', { d: tree(cutOff), lapsed: true, credit: true });
    expect(
      within(screen.getByRole('alert')).queryByRole('button', { name: 'Continue' }),
    ).toBeNull();
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
