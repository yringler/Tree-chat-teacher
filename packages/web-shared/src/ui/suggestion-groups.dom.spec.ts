import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { REPLY_ACTION, type Tangent } from '@tangent/shared';
import { describe, expect, it, vi } from 'vitest';
import { branch, render } from '../testing';
import { SuggestionGroups } from './suggestion-groups';

const SUGGESTED: readonly Tangent[] = [
  { kind: 'continue', title: 'Diffraction', why: 'what a slit does to it next' },
  { kind: 'tangent', title: 'Interference', why: 'why two waves add up' },
  { kind: 'tangent', title: 'Photons', why: null },
];

/** The suggestions, `send` and `open` spies that settle when `settle` is called. */
async function groups(inputs: Record<string, unknown> = {}) {
  let settle = (): void => undefined;
  const pending = () =>
    new Promise<void>((resolve) => {
      settle = resolve;
    });
  const send = vi.fn(pending);
  const open = vi.fn(pending);
  const r = await render(SuggestionGroups, {
    inputs: { tangents: SUGGESTED, latest: true, send, open, ...inputs },
  });
  return { ...r, send, open, settle: () => settle(), user: userEvent.setup() };
}

const group = (name: string) => within(screen.getByRole('navigation', { name }));
const step = () => group('Keep going').getByRole<HTMLButtonElement>('button', { name: /^Diff/ });

describe('SuggestionGroups', () => {
  it('splits the suggestions into Keep going and Tangents', async () => {
    await groups();
    expect(group('Keep going').getAllByRole('button')).toHaveLength(1);
    expect(group('Tangents').getAllByRole('button')).toHaveLength(2);
    group('Tangents').getByRole('button', { name: 'Photons' });
  });

  it('only the newest reply offers Keep going', async () => {
    await groups({ latest: false });
    expect(screen.queryByRole('navigation', { name: 'Keep going' })).toBeNull();
    group('Tangents').getByRole('button', { name: /^Interference/ });
  });

  it('with nothing to offer, shows nothing', async () => {
    const g = await groups({ tangents: [] });
    expect(g.host.textContent?.trim()).toBe('');
  });

  it('Keep going keeps the main thread moving, or inside a tangent, that tangent', async () => {
    const g = await groups();
    expect(step().title).toBe(REPLY_ACTION.hint);
    await g.set({ inTangent: true });
    expect(step().title).toBe(REPLY_ACTION.hintInTangent);
  });

  it('sends a step once, until the send settles', async () => {
    const g = await groups();
    await g.user.click(step());
    expect(g.send).toHaveBeenCalledWith('Diffraction');
    expect(step().disabled).toBe(true);
    await g.user.click(step());
    expect(g.send).toHaveBeenCalledTimes(1);
    g.settle();
    await vi.waitFor(() => expect(step().disabled).toBe(false));
  });

  it('waits while something else is generating', async () => {
    await groups({ busy: true });
    expect(step().disabled).toBe(true);
  });

  it('opens one tangent at a time; a followed one is marked, and lit on the chain', async () => {
    const g = await groups({
      children: [branch('b-photons', { title: 'Photons' })],
      chainIds: new Set(['b-photons']),
    });
    const photons = group('Tangents').getByRole<HTMLButtonElement>('button', { name: 'Photons' });
    expect(photons.title).toBe('Open tangent');
    expect(photons.classList).toContain('is-followed');
    expect(photons.classList).toContain('is-on');
    await g.user.click(photons);
    expect(g.open).toHaveBeenCalledWith('Photons');
    expect(
      group('Tangents').getByRole<HTMLButtonElement>('button', { name: /^Interference/ }).disabled,
    ).toBe(true);
  });

  it('locked: says why in the thread’s own word; a followed tangent still opens', async () => {
    await groups({ locked: true, noun: 'lane', children: [branch('b', { title: 'Photons' })] });
    expect(step().disabled).toBe(true);
    expect(step().title).toBe('Continuing needs a membership (this lane is on your own key)');
    const interference = group('Tangents').getByRole<HTMLButtonElement>('button', {
      name: /^Interference/,
    });
    expect(interference.disabled).toBe(true);
    expect(interference.title).toBe(
      'Starting a tangent needs a membership (this lane is on your own key)',
    );
    expect(
      group('Tangents').getByRole<HTMLButtonElement>('button', { name: 'Photons' }).disabled,
    ).toBe(false);
  });
});
