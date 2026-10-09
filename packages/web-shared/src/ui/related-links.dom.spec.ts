import { indexLinks } from '@tangent/core/links';
import { indexTree } from '@tangent/core/tree';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { branch, detail, link, node, render } from '../testing';
import { relatedLinks } from './links-view';
import { RelatedLinks } from './related-links';

/** a1 ("A wave.") linked to a2 ("A particle."), the note "Both are light". */
function entries() {
  const d = detail(
    [
      node('a1', { content: 'A wave.' }),
      node('a2', { parentId: 'a1', seq: 1, content: 'A particle.' }),
    ],
    [branch('trunk', { title: 'Main thread' })],
    [link('l1', 'a1', 'a2', 'Both are light')],
  );
  return relatedLinks(indexTree(d.branches, d.nodes), indexLinks(d.links), 'a1');
}

async function related(inputs: Record<string, unknown> = {}) {
  const r = await render(RelatedLinks, { inputs: { entries: entries(), ...inputs } });
  const out = { open: vi.fn(), remove: vi.fn(), editNote: vi.fn() };
  r.component.open.subscribe(out.open);
  r.component.remove.subscribe(out.remove);
  r.component.editNote.subscribe(out.editNote);
  return { ...r, ...out, user: userEvent.setup() };
}

describe('RelatedLinks', () => {
  it('renders nothing without links', async () => {
    const r = await related({ entries: [] });
    expect(r.host.textContent?.trim()).toBe('');
  });

  it('behind a toggle that says whether it is open; a chip opens the other end', async () => {
    const r = await related();
    const toggle = screen.getByRole('button', { name: '1 related' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('list')).toBeNull();
    await r.user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe(screen.getByRole('list').id);
    expect(screen.getByText('Both are light')).toBeTruthy();
    await r.user.click(screen.getByRole('button', { name: /A particle\./ }));
    expect(r.open).toHaveBeenCalledWith('a2');
  });

  it('edit and remove are only for editors, and say which link they act on', async () => {
    const r = await related({ expanded: true });
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
    await r.set({ canEdit: true, noun: 'connection' });
    await r.user.click(
      screen.getByRole('button', { name: 'Remove the connection to A particle.' }),
    );
    expect(r.remove).toHaveBeenCalledWith('l1');
  });

  it('edits a note inline: Enter saves it, Escape cancels only the edit', async () => {
    const r = await related({ expanded: true, canEdit: true });
    await r.user.click(
      screen.getByRole('button', { name: 'Edit the note on the link to A particle.' }),
    );
    const note = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Note on this link' });
    expect(note.value).toBe('Both are light');
    expect(note.maxLength).toBeGreaterThan(0);
    let reachedApp = false;
    document.addEventListener('keydown', () => (reachedApp = true), { once: true });
    await r.user.keyboard('{Escape}');
    expect(reachedApp).toBe(false);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(r.editNote).not.toHaveBeenCalled();

    await r.user.click(
      screen.getByRole('button', { name: 'Edit the note on the link to A particle.' }),
    );
    const again = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Note on this link' });
    await r.user.clear(again);
    await r.user.type(again, ' Duality {Enter}');
    expect(r.editNote).toHaveBeenCalledWith({ linkId: 'l1', note: 'Duality' });
  });

  it('listed under a label instead, title-only when compact', async () => {
    await related({ collapsible: false, compact: true });
    expect(screen.queryByRole('button', { name: '1 related' })).toBeNull();
    expect(screen.getByRole('button', { name: /A particle\./ })).toBeTruthy();
    // Compact chips leave out the note.
    expect(screen.queryByText('Both are light')).toBeNull();
  });
});
