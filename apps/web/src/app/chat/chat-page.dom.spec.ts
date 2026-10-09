import { TestBed } from '@angular/core/testing';
import type { TreeDetail } from '@tangent/shared';
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

const CREDIT = provider({ funding: 'credit', acceptsUserKey: false, keySource: 'server' });

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

describe('ChatPage', () => {
  it('shows the open branch’s messages, and a composer that continues it', async () => {
    const p = await page();
    const chat = screen.getByRole('region', { name: 'Conversation' });
    expect(within(chat).getByText('What is light?')).toBeTruthy();
    expect(within(chat).getByText('A wave.')).toBeTruthy();
    expect(composer()?.placeholder).toBe('Continue this thread…');
    const send = vi.spyOn(p.store, 'send').mockResolvedValue(true);
    await p.user.type(composer()!, 'And a particle?{Enter}');
    expect(send).toHaveBeenCalledWith('trunk', 'And a particle?');
  });

  it('a new branch shows where it starts, and asks for its first question', async () => {
    await page({ branchId: 'side' });
    expect(screen.getByText('New branch. Your next message starts it.')).toBeTruthy();
    expect(screen.getByText('A wave', { selector: 'blockquote' })).toBeTruthy();
    expect(composer()?.placeholder).toBe('Ask your question…');
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
