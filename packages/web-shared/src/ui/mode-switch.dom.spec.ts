import { screen } from '@testing-library/dom';
import { describe, expect, it } from 'vitest';
import { DEMO_MODE, conversationHref } from '../core/demo';
import { render } from '../testing';
import { ModeSwitch } from './mode-switch';

function hrefs(): Record<string, string | null> {
  const links = screen.getAllByRole('link');
  return Object.fromEntries(links.map((a) => [a.textContent.trim(), a.getAttribute('href')]));
}

describe('conversationHref', () => {
  it("is the app's home without a conversation, else the tree and branch under it", () => {
    expect(conversationHref('/learn/', null)).toBe('/learn/');
    expect(conversationHref('/learn/', null, 'b1')).toBe('/learn/');
    expect(conversationHref('/', 't1')).toBe('/t/t1');
    expect(conversationHref('/canvas/', 'a/b', 'c d')).toBe('/canvas/t/a%2Fb/b/c%20d');
  });
});

describe('ModeSwitch', () => {
  it("links to the other apps' homes when no conversation is open", async () => {
    await render(ModeSwitch, { inputs: { current: 'power' } });
    expect(hrefs()).toEqual({ Learn: '/learn/', Canvas: '/canvas/' });
    expect(screen.getByText('Power').getAttribute('aria-current')).toBe('page');
  });

  it('opens the same conversation and branch in the other apps', async () => {
    const r = await render(ModeSwitch, {
      inputs: { current: 'simple', treeId: 't1', branchId: 'b2' },
    });
    expect(hrefs()).toEqual({ Power: '/t/t1/b/b2', Canvas: '/canvas/t/t1/b/b2' });
    await r.set({ treeId: null, branchId: null });
    expect(hrefs()).toEqual({ Power: '/', Canvas: '/canvas/' });
  });

  it('stays in the demos, on the same conversation', async () => {
    await render(ModeSwitch, {
      inputs: { current: 'canvas', treeId: 't1', branchId: null },
      providers: [{ provide: DEMO_MODE, useValue: true }],
    });
    expect(hrefs()).toEqual({ Power: '/demo/t/t1', Learn: '/learn/demo/t/t1' });
  });
});
