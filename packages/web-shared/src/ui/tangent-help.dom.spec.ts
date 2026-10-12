import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import {
  HELP_ANALOGY,
  HELP_DEFAULT,
  HELP_REPLAY,
  HELP_RULE,
  HELP_SHORTCUTS,
  HELP_TEST,
  REPLY_ACTION,
  TANGENT_ACTION,
} from '@tangent/shared';
import { describe, expect, it, vi } from 'vitest';
import { render } from '../testing';
import { TangentHelp } from './tangent-help';

async function help(inputs: Record<string, unknown> = {}) {
  const r = await render(TangentHelp, { inputs });
  const out = { replay: vi.fn(), shortcuts: vi.fn() };
  r.component.replay.subscribe(out.replay);
  r.component.shortcuts.subscribe(out.shortcuts);
  return { ...r, ...out, user: userEvent.setup() };
}

describe('TangentHelp', () => {
  it('teaches the rule with both actions named as their buttons are', async () => {
    const h = await help();
    expect(screen.getByText(HELP_RULE)).toBeTruthy();
    expect(screen.getByText(REPLY_ACTION.label)).toBeTruthy();
    expect(screen.getByText(TANGENT_ACTION.label).classList).toContain('is-primary');
    expect(screen.getByText(HELP_DEFAULT.label)).toBeTruthy();
    expect(screen.getByText(HELP_DEFAULT.text)).toBeTruthy();
    expect(screen.getByText(HELP_TEST)).toBeTruthy();
    expect(screen.getByText(HELP_ANALOGY)).toBeTruthy();
    expect(screen.getByRole('img', { name: /main thread/i })).toBeTruthy();
    expect(h.host.innerHTML).not.toContain('branch');
  });

  it('offers the walkthrough again only where it is asked to', async () => {
    const h = await help();
    expect(screen.queryByRole('button', { name: HELP_REPLAY })).toBeNull();
    await h.set({ showReplay: true });
    await h.user.click(screen.getByRole('button', { name: HELP_REPLAY }));
    expect(h.replay).toHaveBeenCalledTimes(1);
  });

  it('leads on to the keyboard shortcuts', async () => {
    const h = await help();
    await h.user.click(screen.getByRole('button', { name: HELP_SHORTCUTS }));
    expect(h.shortcuts).toHaveBeenCalledTimes(1);
    expect(h.replay).not.toHaveBeenCalled();
  });
});
