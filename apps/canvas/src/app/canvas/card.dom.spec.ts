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

const REPLY = [
  'A wave.',
  '',
  '<tangents>',
  '- [continue] Diffraction — what a slit does to it next',
  '- [tangent] Interference — why waves add up',
  '- Photons',
  '</tangents>',
].join('\n');

/**
 * The trunk (own key): u1 → a1, which suggests a next step and two tangents
 * (one untagged); lane "Photons" off a1, on credit. `more`: messages after a1.
 */
function tree(reply: Partial<ChatNode> = {}, more: ChatNode[] = []): TreeDetail {
  return detail(
    [
      node('u1', { role: 'user', content: 'What is light?' }),
      node('a1', { parentId: 'u1', seq: 1, content: REPLY, ...reply }),
      ...more,
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

const suggested = () => screen.getByRole('group', { name: 'Suggested tangents' });
const keepGoing = () => screen.getByRole('group', { name: 'Keep going' });
const lanes = () => screen.getByRole('group', { name: 'Your tangents' });
/** The suggestions no lane follows, folded behind one button since "Photons" is followed. */
const more = () => screen.getByRole<HTMLButtonElement>('button', { name: '1 more suggested' });
const interference = () =>
  within(suggested()).getByRole<HTMLButtonElement>('button', {
    name: /^Start a tangent: Interference/,
  });

describe('Card', () => {
  it('a finished reply: its text, the lanes off it first, then its suggestions', async () => {
    const c = await card('a1');
    expect(screen.getByText('A wave.')).toBeTruthy();
    expect(screen.getByRole('article').textContent).not.toContain('<tangents>');
    const go = vi.spyOn(c.store, 'go').mockImplementation(() => undefined);
    const photons = within(lanes()).getByRole('button', { name: 'Open tangent: Photons' });
    expect(photons.classList).toContain('mode-chip-path');
    await c.user.click(photons);
    expect(go).toHaveBeenCalledWith('photons');
    const follow = vi.spyOn(c.store, 'followTangent').mockResolvedValue(null);
    await c.user.click(more());
    await c.user.click(interference());
    expect(follow).toHaveBeenCalledWith('a1', 'Interference');
  });

  it('the lane on the selected chain is lit', async () => {
    const c = await card('a1');
    c.store.setRoute('t1', 'photons', null);
    await c.fixture.whenStable();
    const photons = within(lanes()).getByRole('button', { name: 'Open tangent: Photons' });
    expect(photons.classList).toContain('is-on');
    expect(photons.getAttribute('aria-current')).toBe('true');
  });

  it('the lane just come back from is lit', async () => {
    const c = await card('a1');
    c.store.setRoute('t1', 'photons', null);
    c.store.setRoute('t1', 'trunk', null);
    await c.fixture.whenStable();
    const photons = within(lanes()).getByRole('button', {
      name: 'Open tangent: Photons (you were just here)',
    });
    expect(photons.classList).toContain('is-back');
  });

  it('pressing a lane off it opens it without selecting the card’s own lane first', async () => {
    // The lane around the card selects itself on pointer down, which would
    // make the card's lane the one just come back from instead.
    const c = await card('a1');
    const laneDown = vi.fn();
    c.host.addEventListener('pointerdown', laneDown);
    const go = vi.spyOn(c.store, 'go').mockImplementation(() => undefined);
    await c.user.click(within(lanes()).getByRole('button', { name: 'Open tangent: Photons' }));
    expect(laneDown).not.toHaveBeenCalled();
    expect(go).toHaveBeenCalledWith('photons');
  });

  it('a question card lists the lanes off it too', async () => {
    const d = tree();
    d.branches.push(
      branch('why', { parentBranchId: 'trunk', branchPointNodeId: 'u1', title: 'Why ask' }),
    );
    await card('u1', { d });
    within(lanes()).getByRole('button', { name: 'Open tangent: Why ask' });
    expect(screen.queryByRole('group', { name: 'Suggested tangents' })).toBeNull();
  });

  it('Tangent opens the tangent dialog on it; the port starts linking from it', async () => {
    const c = await card('a1');
    await c.user.click(screen.getByRole('button', { name: 'Tangent from this message' }));
    expect(c.ui.dialogs.get('branch')).toEqual({ kind: 'branch', fromNodeId: 'a1', quote: null });
    await c.user.click(screen.getByRole('button', { name: 'Link this message to another' }));
    expect(c.ui.linkPick()?.fromNodeId).toBe('a1');
  });

  it('splits the suggestions: Keep going and Suggested tangents, a followed one only as its lane', async () => {
    const c = await card('a1');
    expect(within(keepGoing()).getAllByRole('button')).toHaveLength(1);
    within(keepGoing()).getByRole('button', { name: /^Diffraction/ });
    // "Ask your own" stays in view while the suggestions are folded.
    within(suggested()).getByRole('textbox', { name: 'Ask your own question in a new lane' });
    await c.user.click(more());
    interference();
    expect(within(suggested()).queryByRole('button', { name: /Photons/ })).toBeNull();
  });

  it('a Keep going step is sent as the next message of the lane', async () => {
    const c = await card('a1');
    const continueWith = vi.spyOn(c.store, 'continueWith').mockResolvedValue(true);
    await c.user.click(within(keepGoing()).getByRole('button', { name: /^Diffraction/ }));
    expect(continueWith).toHaveBeenCalledWith('a1', 'Diffraction');
  });

  it('only the latest card of the lane offers Keep going', async () => {
    await card('a1', {
      d: tree({}, [
        node('u2', { role: 'user', parentId: 'a1', seq: 2, content: 'And then?' }),
        node('a2', { parentId: 'u2', seq: 3, content: 'It spreads.' }),
      ]),
    });
    expect(screen.queryByRole('group', { name: 'Keep going' })).toBeNull();
    more();
  });

  it('asks your own question in a new lane', async () => {
    const c = await card('a1');
    const askFrom = vi.spyOn(c.store, 'askFrom').mockResolvedValue(branch('new'));
    const field = screen.getByRole('textbox', { name: 'Ask your own question in a new lane' });
    await c.user.type(field, 'Why does it bend?');
    await c.user.click(screen.getByRole('button', { name: 'Ask' }));
    expect(askFrom).toHaveBeenCalledWith('a1', 'Why does it bend?');
  });

  it('on a lane the membership locks: suggestions and questions are disabled and say why', async () => {
    const c = await card('a1', { lapsed: true });
    const step = within(keepGoing()).getByRole<HTMLButtonElement>('button', {
      name: /^Diffraction/,
    });
    expect(step.disabled).toBe(true);
    expect(step.title).toBe('Continuing needs a membership (this lane is on your own key)');
    const why = 'Starting a tangent needs a membership (this lane is on your own key)';
    expect(more().title).toBe(why);
    await c.user.click(more());
    expect(interference().disabled).toBe(true);
    expect(interference().title).toBe(why);
    // The lane already following one still opens.
    const photons = within(lanes()).getByRole<HTMLButtonElement>('button', {
      name: 'Open tangent: Photons',
    });
    expect(photons.disabled).toBe(false);
    expect(
      screen.getByRole<HTMLTextAreaElement>('textbox', { name: /Ask your own/ }).disabled,
    ).toBe(true);
  });

  it('a reply that is not whole says why', async () => {
    await card('a1', {
      d: tree({ status: 'error', errorKind: 'cut_off', error: 'It hit the limit.' }),
    });
    expect(screen.getByRole('alert').textContent).toContain('Cut off.');
    expect(screen.queryByRole('group', { name: 'Suggested tangents' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Keep going' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tangent from this message' })).toBeNull();
    // The lane already started off it stays the way there.
    within(lanes()).getByRole('button', { name: 'Open tangent: Photons' });
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
