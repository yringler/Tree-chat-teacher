import { Component, signal } from '@angular/core';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchShortcut } from '../core/shortcuts';
import { render } from '../testing';
import { Modal } from './modal';

/**
 * A dialog the way the apps write one: a Modal around a form, shown while
 * `open`; `autofocus` marks its field, `focusHeading` sets the Modal's,
 * `openAt` opens it at its "Replies" section (which takes the focus) or its
 * "Limit" section (which doesn't, and starts with a text field), and `dirty`
 * says it holds unsaved edits. "Keys" opens over it. Escape closes the
 * top-most, from the document's keydown, as in the apps.
 */
@Component({
  imports: [Modal],
  host: { '(document:keydown)': 'onKey($event)' },
  template: `
    <button type="button" (click)="open.set(true)">Open settings</button>
    @if (open()) {
      <app-modal
        heading="Settings"
        [focusHeading]="focusHeading()"
        [openAt]="openAt() === 'replies' ? replies : openAt() === 'limit' ? limit : null"
        [dirty]="dirty"
        (closed)="closed(); open.set(false)"
      >
        <button type="button" disabled>Disabled first</button>
        <input aria-label="Name" [attr.autofocus]="autofocus() ? '' : null" />
        <fieldset tabindex="-1" #replies>
          <legend>Replies</legend>
          <input aria-label="Model" />
        </fieldset>
        <fieldset #limit>
          <legend>Limit</legend>
          <input aria-label="Tokens" />
          <label><input type="radio" name="limit" /> Auto</label>
          <label><input type="radio" name="limit" checked /> 8k</label>
        </fieldset>
        <button type="button">Save</button>
      </app-modal>
    }
    @if (keys()) {
      <app-modal heading="Keys" (closed)="keys.set(false)">
        <input aria-label="Key" />
      </app-modal>
    }
  `,
})
class Host {
  readonly open = signal(false);
  readonly keys = signal(false);
  readonly autofocus = signal(false);
  readonly focusHeading = signal(false);
  readonly openAt = signal<'replies' | 'limit' | null>(null);
  readonly dirty = signal(false);
  readonly closed = vi.fn();

  onKey(e: KeyboardEvent): void {
    dispatchShortcut(e, {
      closeTop: () => {
        const top = [this.keys, this.open].find((s) => s());
        top?.set(false);
        return !!top;
      },
      dialogOpen: () => this.open() || this.keys(),
    });
  }
}

async function opened(
  set: {
    autofocus?: boolean;
    focusHeading?: boolean;
    openAt?: 'replies' | 'limit';
    dirty?: boolean;
  } = {},
) {
  const r = await render(Host);
  r.component.autofocus.set(set.autofocus ?? false);
  r.component.focusHeading.set(set.focusHeading ?? false);
  r.component.openAt.set(set.openAt ?? null);
  r.component.dirty.set(set.dirty ?? false);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Open settings' }));
  await r.fixture.whenStable();
  return { ...r, user };
}

describe('Modal', () => {
  it('is a modal dialog named by its heading, focusing the first usable control', async () => {
    await opened();
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Name')));
  });

  it('a dialog read before it is edited (focusHeading) opens on its heading', async () => {
    await opened({ focusHeading: true });
    const heading = screen.getByRole('heading', { name: 'Settings' });
    await vi.waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it('opened at a section (openAt), focuses that section rather than its first field', async () => {
    await opened({ openAt: 'replies', autofocus: true });
    const replies = screen.getByRole('group', { name: 'Replies' });
    await vi.waitFor(() => expect(document.activeElement).toBe(replies));
  });

  it('opened at a section that takes no focus, scrolls to its top and focuses its first choice: the checked radio, past a text field', async () => {
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView');
    await opened({ openAt: 'limit', autofocus: true });
    const limit = screen.getByRole('group', { name: 'Limit' });
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('radio', { name: '8k' })),
    );
    expect(scrolled.mock.contexts).toEqual([limit]);
    expect(scrolled).toHaveBeenCalledWith({ block: 'start' });
    scrolled.mockRestore();
  });

  describe('on a touch screen (no hover)', () => {
    beforeEach(() =>
      vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(hover: none)' })),
    );
    afterEach(() => vi.unstubAllGlobals());

    it('opens on its heading, so no on-screen keyboard comes up over it', async () => {
      await opened();
      const heading = screen.getByRole('heading', { name: 'Settings' });
      await vi.waitFor(() => expect(document.activeElement).toBe(heading));
    });

    it('even where a field asks for the focus (autofocus)', async () => {
      await opened({ autofocus: true });
      const heading = screen.getByRole('heading', { name: 'Settings' });
      await vi.waitFor(() => expect(document.activeElement).toBe(heading));
    });

    it('but opened at a section, focuses it there too: it is no field, so no keyboard comes up', async () => {
      await opened({ openAt: 'replies' });
      const replies = screen.getByRole('group', { name: 'Replies' });
      await vi.waitFor(() => expect(document.activeElement).toBe(replies));
    });

    it('or its first choice, never the text field before it', async () => {
      await opened({ openAt: 'limit' });
      await vi.waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole('radio', { name: '8k' })),
      );
    });
  });

  it('Close closes it and hands the focus back to what opened it', async () => {
    const m = await opened();
    const trigger = screen.getByRole('button', { name: 'Open settings' });
    await m.user.click(screen.getByRole('button', { name: 'Close' }));
    await m.fixture.whenStable();
    expect(m.component.closed).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('a click on the backdrop closes it too', async () => {
    const m = await opened();
    await m.user.click(m.host.querySelector<HTMLElement>('.backdrop')!);
    expect(m.component.closed).toHaveBeenCalledTimes(1);
  });

  it('Escape closes it at once while nothing is unsaved', async () => {
    const m = await opened();
    await m.user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  describe('with unsaved edits (dirty)', () => {
    const ask = () => screen.queryByRole('alertdialog', { name: 'Discard your changes?' });
    const keepEditing = () => screen.getByRole('button', { name: 'Keep editing' });
    /** The focus leaves for the page's body. */
    const blur = () => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      expect(document.activeElement).toBe(document.body);
    };

    it('Escape asks before discarding them; Keep editing, the default, returns the focus where it was', async () => {
      const m = await opened({ dirty: true });
      const name = screen.getByLabelText('Name');
      await m.user.click(name);
      await m.user.keyboard('{Escape}');
      expect(ask()).not.toBeNull();
      screen.getByRole('dialog', { name: 'Settings' });
      await vi.waitFor(() => expect(document.activeElement).toBe(keepEditing()));
      // While it asks, the dialog behind it can't be used.
      expect(m.host.querySelector('.modal-body')?.hasAttribute('inert')).toBe(true);

      await m.user.click(keepEditing());
      expect(ask()).toBeNull();
      expect(m.host.querySelector('.modal-body')?.hasAttribute('inert')).toBe(false);
      await vi.waitFor(() => expect(document.activeElement).toBe(name));
      expect(m.component.closed).not.toHaveBeenCalled();
    });

    it('Escape on the question keeps editing', async () => {
      const m = await opened({ dirty: true });
      const name = screen.getByLabelText('Name');
      await m.user.click(name);
      await m.user.keyboard('{Escape}');
      await vi.waitFor(() => expect(document.activeElement).toBe(keepEditing()));
      await m.user.keyboard('{Escape}');
      expect(ask()).toBeNull();
      screen.getByRole('dialog', { name: 'Settings' });
      await vi.waitFor(() => expect(document.activeElement).toBe(name));
    });

    it('a backdrop tap asks too, Keep editing returns the focus the tap took, and Discard closes it', async () => {
      const m = await opened({ dirty: true });
      const name = screen.getByLabelText('Name');
      await m.user.click(name);
      const backdrop = m.host.querySelector<HTMLElement>('.backdrop')!;
      await m.user.click(backdrop);
      expect(ask()).not.toBeNull();
      expect(m.component.closed).not.toHaveBeenCalled();
      await m.user.click(keepEditing());
      await vi.waitFor(() => expect(document.activeElement).toBe(name));

      await m.user.click(backdrop);
      await m.user.click(screen.getByRole('button', { name: 'Discard' }));
      expect(m.component.closed).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('asks when the focus has left the dialog too, as when the button it was on goes away', async () => {
      const m = await opened({ dirty: true });
      await m.user.click(screen.getByLabelText('Name'));
      blur();
      await m.user.keyboard('{Escape}');
      expect(ask()).not.toBeNull();
      screen.getByRole('dialog', { name: 'Settings' });
    });

    it('only the top-most dialog asks: Escape closes one without edits above it first', async () => {
      const m = await opened({ dirty: true });
      m.component.keys.set(true);
      await m.fixture.whenStable();
      blur();
      await m.user.keyboard('{Escape}');
      expect(ask()).toBeNull();
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
      screen.getByRole('dialog', { name: 'Settings' });
      await m.user.keyboard('{Escape}');
      expect(ask()).not.toBeNull();
    });

    it('counts an edit made a moment before Escape, before the page has caught up with it', async () => {
      const m = await opened();
      await m.user.click(screen.getByLabelText('Name'));
      m.component.dirty.set(true);
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      await m.fixture.whenStable();
      expect(ask()).not.toBeNull();
      screen.getByRole('dialog', { name: 'Settings' });
    });

    it('Close is an explicit discard: it closes without asking', async () => {
      const m = await opened({ dirty: true });
      await m.user.click(screen.getByRole('button', { name: 'Close' }));
      expect(ask()).toBeNull();
      expect(m.component.closed).toHaveBeenCalledTimes(1);
    });
  });
});
