import { indexLinks } from '@tangent/core/links';
import { indexTree } from '@tangent/core/tree';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { branch, detail, link, node, render } from '../testing';
import { NodePicker } from './node-picker';

/** Main thread u1 → a1, a3; "Particles" off a1 (a2); a1 already linked to a3. */
function tree() {
  const d = detail(
    [
      node('u1', { role: 'user', content: 'What is light?' }),
      node('a1', { parentId: 'u1', seq: 1, content: 'A wave.' }),
      node('a3', { parentId: 'a1', seq: 2, content: 'Or both.' }),
      node('a2', { branchId: 'side', parentId: 'a1', content: 'A particle.' }),
    ],
    [
      branch('trunk', { title: 'Main thread' }),
      branch('side', { parentBranchId: 'trunk', branchPointNodeId: 'a1', title: 'Particles' }),
    ],
    [link('l1', 'a1', 'a3')],
  );
  return { index: indexTree(d.branches, d.nodes), linksByNode: indexLinks(d.links) };
}

async function picker(inputs: Record<string, unknown> = {}) {
  const r = await render(NodePicker, { inputs: { ...tree(), sourceNodeId: 'a1', ...inputs } });
  const out = { picked: vi.fn(), cancelled: vi.fn() };
  r.component.picked.subscribe(out.picked);
  r.component.cancelled.subscribe(out.cancelled);
  const search = screen.getByRole<HTMLInputElement>('combobox', {
    name: 'Search messages and tangents',
  });
  return { ...r, ...out, search, user: userEvent.setup() };
}

const options = () => screen.queryAllByRole('option').map((o) => o.textContent?.trim());

describe('NodePicker', () => {
  it('a search box over a list of the other messages, without the source or what it links to', async () => {
    const p = await picker();
    screen.getByRole('listbox', { name: 'All messages' });
    expect(options()).toEqual([
      expect.stringMatching(/^You:\s*What is light\?$/),
      expect.stringMatching(/^Tangent:\s*Particles$/),
    ]);
    const active = screen
      .getAllByRole('option')
      .find((o) => o.getAttribute('aria-selected') === 'true');
    expect(p.search.getAttribute('aria-activedescendant')).toBe(active?.id);
  });

  it('searching narrows the list, and says when nothing matches', async () => {
    const p = await picker();
    await p.user.type(p.search, 'particle');
    screen.getByRole('listbox', { name: 'Matching messages' });
    expect(options()).toHaveLength(1);
    await p.user.clear(p.search);
    await p.user.type(p.search, 'owls');
    expect(options()).toEqual([]);
    expect(screen.getByText('No messages match “owls”.')).toBeTruthy();
  });

  it('Enter picks the highlighted message, then asks for a note; Link links', async () => {
    const p = await picker();
    p.search.focus();
    await p.user.keyboard('{ArrowDown}{Enter}');
    expect(screen.queryByRole('combobox')).toBeNull();
    await p.user.type(screen.getByRole('textbox', { name: 'Note (optional)' }), ' Same topic ');
    await p.user.click(screen.getByRole('button', { name: 'Link' }));
    expect(p.picked).toHaveBeenCalledWith({ nodeId: 'a2', note: 'Same topic' });
  });

  it('Change goes back to the list; without a note, a click picks at once', async () => {
    const p = await picker();
    await p.user.click(screen.getAllByRole('option')[0]!);
    await p.user.click(screen.getByRole('button', { name: 'Change' }));
    screen.getByRole('combobox');
    await p.set({ withNote: false });
    await p.user.click(screen.getAllByRole('option')[0]!);
    expect(p.picked).toHaveBeenCalledWith({ nodeId: 'u1', note: null });
  });

  it('Cancel and Escape cancel, and Escape goes no further', async () => {
    const p = await picker();
    await p.user.click(screen.getByRole('button', { name: 'Cancel' }));
    let reachedApp = false;
    document.addEventListener('keydown', () => (reachedApp = true), { once: true });
    p.search.focus();
    await p.user.keyboard('{Escape}');
    expect(p.cancelled).toHaveBeenCalledTimes(2);
    expect(reachedApp).toBe(false);
  });
});
