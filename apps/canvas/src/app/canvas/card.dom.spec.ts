import { TestBed } from '@angular/core/testing';
import type { ChatNode, TreeDetail } from '@tangent/shared';
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
import { CanvasStore } from '../state/canvas-store';
import { UiStore } from '../state/ui-store';
import { Card } from './card';

const REPLY = 'A wave.\n\n<tangents>\n- Interference — why waves add up\n- Photons\n</tangents>';

/** The trunk (own key): u1 → a1, which suggests two tangents; lane "Photons" off a1, on credit. */
function tree(reply: Partial<ChatNode> = {}): TreeDetail {
  return detail(
    [
      node('u1', { role: 'user', content: 'What is light?' }),
      node('a1', { parentId: 'u1', seq: 1, content: REPLY, ...reply }),
    ],
    [
      branch('trunk', { title: 'Main thread' }),
      branch('photons', {
        parentBranchId: 'trunk',
        branchPointNodeId: 'a1',
        title: 'Photons',
        funding: 'credit',
      }),
    ],
  );
}

/** Card `nodeId`; `lapsed`: the membership the own-key trunk needs ended (credit still works). */
async function card(nodeId: string, opts: { lapsed?: boolean; d?: TreeDetail } = {}) {
  const d = opts.d ?? tree();
  const r = await render(Card, {
    providers: powerProviders(CanvasStore, {}),
    setup: () => {
      const store = TestBed.inject(CanvasStore);
      signIn(store.account, {
        membership: opts.lapsed ? membership({ status: 'inactive' }) : undefined,
        providers: [
          provider(),
          provider({ funding: 'credit', acceptsUserKey: false, keySource: 'server' }),
        ],
        builtInCredit: true,
        billing: { availableMicros: 1_000_000 } as never,
      });
      openTree(store, d);
    },
    inputs: { node: d.nodes.find((n) => n.id === nodeId) },
  });
  return {
    ...r,
    store: TestBed.inject(CanvasStore),
    ui: TestBed.inject(UiStore),
    user: userEvent.setup(),
  };
}

const tangents = () => screen.getByRole('navigation', { name: 'Tangents worth following' });

describe('Card', () => {
  it('a finished reply: its text, its tangents, and the lanes off it', async () => {
    const c = await card('a1');
    expect(screen.getByText('A wave.')).toBeTruthy();
    expect(screen.getByRole('article').textContent).not.toContain('<tangents>');
    const follow = vi.spyOn(c.store, 'followTangent').mockResolvedValue(null);
    await c.user.click(within(tangents()).getByRole('button', { name: /^Interference/ }));
    expect(follow).toHaveBeenCalledWith('a1', 'Interference');
    const lanes = screen.getByRole('navigation', { name: 'Lanes branching from this message' });
    const go = vi.spyOn(c.store, 'go').mockImplementation(() => undefined);
    await c.user.click(within(lanes).getByRole('button', { name: 'Photons' }));
    expect(go).toHaveBeenCalledWith('photons');
  });

  it('Branch opens the branch dialog on it; the port starts linking from it', async () => {
    const c = await card('a1');
    await c.user.click(screen.getByRole('button', { name: 'Branch from this message' }));
    expect(c.ui.dialogs.get('branch')).toEqual({ kind: 'branch', fromNodeId: 'a1', quote: null });
    await c.user.click(screen.getByRole('button', { name: 'Link this message to another' }));
    expect(c.ui.linkPick()?.fromNodeId).toBe('a1');
  });

  it('asks your own question in a new lane', async () => {
    const c = await card('a1');
    const askFrom = vi.spyOn(c.store, 'askFrom').mockResolvedValue(branch('new'));
    const field = screen.getByRole('textbox', { name: 'Ask your own question in a new lane' });
    await c.user.type(field, 'Why does it bend?');
    await c.user.click(screen.getByRole('button', { name: 'Ask' }));
    expect(askFrom).toHaveBeenCalledWith('a1', 'Why does it bend?');
  });

  it('on a lane the membership locks: new tangents and questions are disabled and say why', async () => {
    await card('a1', { lapsed: true });
    const interference = within(tangents()).getByRole<HTMLButtonElement>('button', {
      name: /^Interference/,
    });
    expect(interference.disabled).toBe(true);
    expect(interference.title).toBe(
      'Following it needs a membership (this lane is on your own key)',
    );
    // The lane already following one still opens.
    const photons = within(tangents()).getByRole<HTMLButtonElement>('button', { name: 'Photons' });
    expect(photons.disabled).toBe(false);
    expect(photons.title).toBe('Open this lane');
    expect(
      screen.getByRole<HTMLTextAreaElement>('textbox', { name: /Ask your own/ }).disabled,
    ).toBe(true);
  });

  it('a reply that is not whole says why', async () => {
    await card('a1', {
      d: tree({ status: 'error', errorKind: 'cut_off', error: 'It hit the limit.' }),
    });
    expect(screen.getByRole('alert').textContent).toContain('Cut off.');
    expect(screen.queryByRole('navigation', { name: 'Tangents worth following' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Branch from this message' })).toBeNull();
  });

  it('in pick mode, "Link here" links this card; the source card cannot be picked', async () => {
    const c = await card('a1');
    const createLink = vi.spyOn(c.store, 'createLink').mockResolvedValue(null);
    c.ui.linkPick.set({ fromNodeId: 'u1' });
    await c.fixture.whenStable();
    await c.user.click(screen.getByRole('button', { name: 'Link here' }));
    expect(createLink).toHaveBeenCalledWith('u1', 'a1');
    c.ui.linkPick.set({ fromNodeId: 'a1' });
    await c.fixture.whenStable();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Linking from here' }).disabled,
    ).toBe(true);
  });
});
