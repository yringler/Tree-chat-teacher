import { TestBed } from '@angular/core/testing';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { provideTextSize, TextSizeStore } from '../core/text-size-store';
import { render } from '../testing';
import { TextSizeMenu } from './text-size-menu';

async function menu(inputs: Record<string, unknown> = {}) {
  const r = await render(TextSizeMenu, {
    inputs,
    providers: [provideTextSize('tangent.test.chatFontScale')],
  });
  return { ...r, size: TestBed.inject(TextSizeStore), user: userEvent.setup() };
}

const trigger = () => screen.getByRole('button', { name: 'Text size' });

describe('TextSizeMenu', () => {
  it('"Aa" opens A−, the size, A+ and Reset', async () => {
    const m = await menu({ heading: 'Lesson text size' });
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('group')).toBeNull();
    await m.user.click(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    screen.getByRole('group', { name: 'Lesson text size' });
    expect(screen.getByRole('status').textContent).toBe('100%');
    // At the usual size, Reset has nothing to do.
    expect(
      screen.getByRole('button', { name: 'Reset to 100%' }).getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('A+ and A− change the size, and Reset brings it back', async () => {
    const m = await menu();
    await m.user.click(trigger());
    await m.user.click(screen.getByRole('button', { name: 'Larger text' }));
    expect(m.size.scale()).toBeGreaterThan(1);
    expect(screen.getByRole('status').textContent).not.toBe('100%');
    await m.user.click(screen.getByRole('button', { name: 'Reset to 100%' }));
    expect(m.size.scale()).toBe(1);
    await m.user.click(screen.getByRole('button', { name: 'Smaller text' }));
    expect(m.size.scale()).toBeLessThan(1);
  });

  it('Escape closes it and hands the focus back to "Aa", keeping the key from the app', async () => {
    const m = await menu();
    await m.user.click(trigger());
    let reachedApp = false;
    document.addEventListener('keydown', () => (reachedApp = true), { once: true });
    await m.user.click(screen.getByRole('button', { name: 'Larger text' }));
    await m.user.keyboard('{Escape}');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger());
    expect(reachedApp).toBe(false);
  });

  it('Escape while it is closed is left to the app', async () => {
    const m = await menu();
    trigger().focus();
    let reachedApp = false;
    document.addEventListener('keydown', () => (reachedApp = true), { once: true });
    await m.user.keyboard('{Escape}');
    expect(reachedApp).toBe(true);
  });

  it('names the shortcuts only where the app has them', async () => {
    const m = await menu();
    expect(trigger().title).toBe('Text size');
    await m.set({ shortcuts: true });
    expect(trigger().title).toBe('Text size (- / +)');
  });
});
