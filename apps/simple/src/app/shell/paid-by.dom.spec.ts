import { TestBed } from '@angular/core/testing';
import { DEMO_MODE } from '@tangent/web-shared';
import { appProviders, billing, render } from '@tangent/web-shared/testing';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { learner, NOT_A_MEMBER, POOL_ON } from '../learn.testing';
import { UiStore } from '../state/ui-store';
import { PaidBy } from './paid-by';

/** The "Paid by" pill (`variant`) for what `facts` say of the learner. */
async function pill(
  variant: 'header' | 'inline',
  facts: Parameters<typeof learner>[0] = {},
  demo = false,
) {
  const r = await render(PaidBy, {
    inputs: { variant },
    providers: [...appProviders({}), { provide: DEMO_MODE, useValue: demo }],
    setup: () => {
      learner(facts);
    },
  });
  return { ...r, ui: TestBed.inject(UiStore), user: userEvent.setup() };
}

const CREDIT = { billing: billing({ availableMicros: 1_200_000 }), chosen: 'credit' } as const;

describe('Paid by', () => {
  it('in the header: what replies run on and what is left, opening "How replies are paid for"', async () => {
    const p = await pill('header', CREDIT);
    p.ui.menuOpen.set(true);
    const button = screen.getByRole('button', {
      name: 'Replies paid by Tangent credit, $1.20 left. Change how replies are paid for',
    });
    expect(button.textContent?.replace(/\s+/g, ' ').trim()).toBe('Credit · $1.20');
    await p.user.click(button);
    expect(p.ui.dialogs.isOpen('access')).toBe(true);
    expect(p.ui.menuOpen()).toBe(false);
  });

  it('on the open pool, the pool’s dollars', async () => {
    await pill('header', { pool: POOL_ON, chosen: 'pool' });
    const button = screen.getByRole('button', {
      name: /^Replies paid by Open pool, \$2\.00 in the pool\./,
    });
    expect(button.textContent?.replace(/\s+/g, ' ').trim()).toBe('Pool · $2.00');
  });

  it('on the own key with none saved, asks for one, as a warning', async () => {
    await pill('header', { ownKey: false });
    const button = screen.getByRole('button', {
      name: /^Replies paid by Your OpenRouter key, no key saved\./,
    });
    expect(button.textContent?.trim()).toBe('Add your key');
    expect(button.classList).toContain('balance-low');
  });

  it('on the own key it needs a membership for, says so', async () => {
    await pill('header', { membership: NOT_A_MEMBER, chosen: 'own-key' });
    screen.getByRole('button', {
      name: /^Replies paid by Your OpenRouter key, needs a membership\./,
    });
  });

  it('beside Start lesson: "Replies paid by" the payer, with Change', async () => {
    const p = await pill('inline', CREDIT);
    expect(p.host.textContent).toContain('Replies paid by');
    const button = screen.getByRole('button', {
      name: 'Tangent credit, $1.20 left. Change how replies are paid for',
    });
    expect(button.textContent).toContain('Change');
    await p.user.click(button);
    expect(p.ui.dialogs.isOpen('access')).toBe(true);
  });

  it('in the demo, which has no such dialog: a link to billing, and plain text', async () => {
    await pill('header', CREDIT, true);
    expect(screen.queryByRole('button')).toBeNull();
    const link = screen.getByRole('link', {
      name: /^Replies paid by Tangent credit, \$1\.20 left\. Open billing$/,
    });
    expect(link.getAttribute('href')).toBe('/billing');
  });
});
