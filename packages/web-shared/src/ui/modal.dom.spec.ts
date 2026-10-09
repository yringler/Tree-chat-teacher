import { Component, signal } from '@angular/core';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { render } from '../testing';
import { Modal } from './modal';

/** A dialog the way the apps write one: a Modal around a form, shown while `open`. */
@Component({
  imports: [Modal],
  template: `
    <button type="button" (click)="open.set(true)">Open settings</button>
    @if (open()) {
      <app-modal heading="Settings" (closed)="closed(); open.set(false)">
        <button type="button" disabled>Disabled first</button>
        <input aria-label="Name" />
        <button type="button">Save</button>
      </app-modal>
    }
  `,
})
class Host {
  readonly open = signal(false);
  readonly closed = vi.fn();
}

async function opened() {
  const r = await render(Host);
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
});
