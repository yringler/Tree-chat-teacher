import { TestBed } from '@angular/core/testing';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { render } from '../testing';
import { provideSidebar, SidebarState } from './sidebar-host';
import { SidebarToggle } from './sidebar-toggle';

describe('SidebarToggle', () => {
  it('hides and shows the sidebar on wide screens, and the choice is remembered', async () => {
    const { fixture } = await render(SidebarToggle);
    const state = TestBed.inject(SidebarState);
    expect(state.hidden()).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }));
    await fixture.whenStable();
    expect(state.hidden()).toBe(true);
    expect(localStorage.getItem('tangent.sidebarHidden')).toBe('1');
    const show = screen.getByRole('button', { name: 'Show sidebar' });
    expect(show.getAttribute('aria-expanded')).toBe('false');

    await userEvent.click(show);
    expect(state.hidden()).toBe(false);
    expect(localStorage.getItem('tangent.sidebarHidden')).toBeNull();
  });

  it('starts hidden when the app saved it hidden under its own key', async () => {
    localStorage.setItem('tangent.canvas.sidebarHidden', '1');
    await render(SidebarToggle, { providers: [provideSidebar('tangent.canvas.sidebarHidden')] });
    expect(TestBed.inject(SidebarState).hidden()).toBe(true);
    expect(screen.getByRole('button', { name: 'Show sidebar' })).toBeTruthy();
  });

  it('opens the drawer on narrow screens', async () => {
    await render(SidebarToggle);
    await userEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(TestBed.inject(SidebarState).drawerOpen()).toBe(true);
  });
});
