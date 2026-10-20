import { TestBed } from '@angular/core/testing';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { WALKTHROUGH_BUTTONS, WALKTHROUGH_STEPS } from '@tangent/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettings, render } from '../testing';
import { COACH_TARGET_CLASS, CoachMark } from './coach-mark';
import { Walkthrough } from './walkthrough';

function fakeApi() {
  const settings = accountSettings();
  return {
    settings: vi.fn(async () => settings),
    updateSettings: vi.fn(async () => settings),
  };
}

/** The app's controls the coach marks point at. */
function controls() {
  const tangent = document.createElement('button');
  tangent.dataset['action'] = 'tangent';
  tangent.textContent = 'Tangent ↳';
  const clicks = vi.fn();
  tangent.addEventListener('click', clicks);
  const back = document.createElement('a');
  back.dataset['coach'] = 'main-thread';
  back.href = '#';
  back.textContent = 'Main thread';
  document.body.append(tangent, back);
  return { tangent, back, clicks };
}

async function coachMark() {
  const api = fakeApi();
  const r = await render(CoachMark);
  const walkthrough = TestBed.inject(Walkthrough);
  await walkthrough.start(api);
  const shown = async () => {
    TestBed.tick();
    await r.fixture.whenStable();
  };
  return { ...r, api, walkthrough, shown, user: userEvent.setup() };
}

const callout = () => document.querySelector<HTMLElement>('.coach-mark');

describe('CoachMark', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('shows the current step next to its control, which stays clickable', async () => {
    const c = await coachMark();
    const { tangent, clicks } = controls();
    expect(callout()?.classList).not.toContain('is-open');
    c.walkthrough.onTrunkReplyReady();
    await c.shown();
    expect(callout()?.classList).toContain('is-open');
    expect(callout()?.textContent).toContain(WALKTHROUGH_STEPS.tangent);
    expect(tangent.classList).toContain(COACH_TARGET_CLASS);
    expect(document.querySelector('.backdrop')).toBeNull();
    // Nothing covers the control: the learner goes on by using it.
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Got it' }));
    await c.user.click(tangent);
    expect(clicks).toHaveBeenCalledOnce();
  });

  it('"Got it" and "Skip tour" move the walkthrough on', async () => {
    const c = await coachMark();
    controls();
    c.walkthrough.onEnteredTangent();
    await c.shown();
    expect(callout()?.textContent).toContain(WALKTHROUGH_STEPS.back);
    await c.user.click(screen.getByRole('button', { name: WALKTHROUGH_BUTTONS.next }));
    await c.shown();
    expect(c.walkthrough.current()).toBeNull();
    c.walkthrough.onBackOnTrunk();
    const next = document.createElement('button');
    next.dataset['action'] = 'next';
    document.body.append(next);
    await c.shown();
    await c.user.click(screen.getByRole('button', { name: WALKTHROUGH_BUTTONS.skip }));
    await c.shown();
    expect(c.walkthrough.active()).toBe(false);
    expect(c.api.updateSettings).toHaveBeenCalledExactlyOnceWith({ walkthroughDone: true });
  });

  it('waits for a control not on the page yet', async () => {
    const c = await coachMark();
    c.walkthrough.onTrunkReplyReady();
    await c.shown();
    expect(callout()?.classList).not.toContain('is-open');
    const { tangent } = controls();
    await vi.waitFor(() => expect(callout()?.classList).toContain('is-open'));
    expect(tangent.classList).toContain(COACH_TARGET_CLASS);
    tangent.remove();
    await vi.waitFor(() => expect(callout()?.classList).not.toContain('is-open'));
  });

  it('comes back with its control however long it was gone', async () => {
    const c = await coachMark();
    const { tangent } = controls();
    c.walkthrough.onTrunkReplyReady();
    await c.shown();
    expect(callout()?.classList).toContain('is-open');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // Stop stands in for the composer's actions while a long reply streams.
      tangent.remove();
      await vi.waitFor(() => expect(callout()?.classList).not.toContain('is-open'));
      vi.advanceTimersByTime(60_000);
    } finally {
      vi.useRealTimers();
    }
    document.body.append(tangent);
    await vi.waitFor(() => expect(callout()?.classList).toContain('is-open'));
    expect(tangent.classList).toContain(COACH_TARGET_CLASS);
  });

  it('Escape leaves a step alone while its control is gone', async () => {
    const c = await coachMark();
    const { tangent } = controls();
    c.walkthrough.onTrunkReplyReady();
    await c.shown();
    tangent.remove();
    await vi.waitFor(() => expect(callout()?.classList).not.toContain('is-open'));
    await c.user.keyboard('{Escape}');
    expect(c.walkthrough.current()?.step).toBe(1);
  });

  it('takes itself down when the tour ends, and Escape skips it', async () => {
    const c = await coachMark();
    const { tangent } = controls();
    c.walkthrough.onTrunkReplyReady();
    await c.shown();
    await c.user.keyboard('{Escape}');
    await c.shown();
    expect(c.walkthrough.active()).toBe(false);
    expect(callout()?.classList).not.toContain('is-open');
    expect(callout()?.textContent?.trim()).toBe('');
    expect(tangent.classList).not.toContain(COACH_TARGET_CLASS);
    expect(c.api.updateSettings).toHaveBeenCalledOnce();
  });

  it('leaves Escape to an open dialog', async () => {
    const c = await coachMark();
    controls();
    const dialog = document.createElement('section');
    dialog.setAttribute('aria-modal', 'true');
    document.body.append(dialog);
    c.walkthrough.onTrunkReplyReady();
    await c.shown();
    await c.user.keyboard('{Escape}');
    expect(c.walkthrough.current()?.step).toBe(1);
  });
});
