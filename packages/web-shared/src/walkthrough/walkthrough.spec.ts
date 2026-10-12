import type { SettingsResponse, UpdateSettingsRequest } from '@tangent/shared';
import { WALKTHROUGH_BUTTONS, WALKTHROUGH_STEPS } from '@tangent/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Walkthrough,
  WALKTHROUGH_OFF,
  walkthroughStep,
  type WalkthroughEvent,
  type WalkthroughState,
} from './walkthrough';

function fakeApi(walkthroughDoneAt: string | null = null) {
  return {
    settings: vi.fn(async (): Promise<SettingsResponse> => ({
      systemPrompt: null,
      defaultSystemPrompt: 'Be a tutor.',
      walkthroughDoneAt,
    })),
    updateSettings: vi.fn(async (_req: UpdateSettingsRequest): Promise<SettingsResponse> => ({
      systemPrompt: null,
      defaultSystemPrompt: 'Be a tutor.',
      walkthroughDoneAt: '2026-10-12T00:00:00.000Z',
    })),
  };
}

async function started(doneAt: string | null = null) {
  const api = fakeApi(doneAt);
  const w = new Walkthrough();
  await w.start(api);
  return { w, api };
}

const run = (events: WalkthroughEvent[], from: WalkthroughState = WALKTHROUGH_OFF) =>
  events.reduce(walkthroughStep, from);

describe('walkthroughStep', () => {
  it('waits for each step until the learner reaches it', () => {
    expect(run(['start'])).toEqual({ step: 1, shown: false });
    expect(run(['start', 'backOnTrunk'])).toEqual({ step: 1, shown: false });
    expect(run(['start', 'trunkReplyReady'])).toEqual({ step: 1, shown: true });
    expect(run(['start', 'trunkReplyReady', 'next'])).toEqual({ step: 2, shown: false });
    expect(run(['start', 'trunkReplyReady', 'next', 'trunkReplyReady'])).toEqual({
      step: 2,
      shown: false,
    });
    expect(run(['start', 'trunkReplyReady', 'next', 'enteredTangent'])).toEqual({
      step: 2,
      shown: true,
    });
  });

  it('goes round the loop: tangent, back to the main thread, next', () => {
    const steps: WalkthroughEvent[] = ['start', 'trunkReplyReady', 'enteredTangent'];
    expect(run(steps)).toEqual({ step: 2, shown: true });
    expect(run([...steps, 'enteredTangent'])).toEqual({ step: 2, shown: true });
    expect(run([...steps, 'backOnTrunk'])).toEqual({ step: 3, shown: true });
    expect(run([...steps, 'backOnTrunk', 'next'])).toEqual({ step: 'done' });
    // "Got it" inside the tangent: step 3 waits for the main thread.
    expect(run([...steps, 'next'])).toEqual({ step: 3, shown: false });
    expect(run([...steps, 'next', 'enteredTangent'])).toEqual({ step: 3, shown: false });
    expect(run([...steps, 'next', 'backOnTrunk'])).toEqual({ step: 3, shown: true });
  });

  it('a reply sent with Next ➜ on step 3 ends it, as Done does', () => {
    const steps: WalkthroughEvent[] = ['start', 'trunkReplyReady', 'enteredTangent'];
    expect(run([...steps, 'backOnTrunk', 'replied'])).toEqual({ step: 'done' });
    // Before step 3 is shown, a reply is just a reply.
    expect(run(['start', 'trunkReplyReady', 'replied'])).toEqual({ step: 1, shown: true });
    expect(run([...steps, 'next', 'replied'])).toEqual({ step: 3, shown: false });
  });

  it('a tangent entered before step 1 showed goes straight to step 2', () => {
    expect(run(['start', 'enteredTangent'])).toEqual({ step: 2, shown: true });
  });

  it('skips from any step, and stays off or done whatever happens', () => {
    expect(run(['start', 'skip'])).toEqual({ step: 'done' });
    expect(run(['start', 'enteredTangent', 'skip'])).toEqual({ step: 'done' });
    const events: WalkthroughEvent[] = ['trunkReplyReady', 'enteredTangent', 'backOnTrunk'];
    expect(run(events)).toEqual(WALKTHROUGH_OFF);
    expect(run(events, { step: 'done' })).toEqual({ step: 'done' });
    // "Got it" on a step that isn't shown does nothing.
    expect(run(['start', 'next'])).toEqual({ step: 1, shown: false });
  });
});

describe('Walkthrough', () => {
  afterEach(() => vi.restoreAllMocks());

  it('starts for an account that has not had it, and shows step 1 once a reply is in', async () => {
    const { w, api } = await started();
    expect(w.active()).toBe(true);
    expect(w.current()).toBeNull();
    w.onTrunkReplyReady();
    expect(w.current()).toEqual({
      step: 1,
      text: WALKTHROUGH_STEPS.tangent,
      target: '[data-action="tangent"]',
      placement: 'top',
      buttonText: WALKTHROUGH_BUTTONS.next,
      skipText: WALKTHROUGH_BUTTONS.skip,
    });
    await w.start(api);
    expect(api.settings).toHaveBeenCalledTimes(1);
  });

  it('stays off for an account that has had it', async () => {
    const { w } = await started('2026-10-01T00:00:00.000Z');
    w.onTrunkReplyReady();
    expect(w.active()).toBe(false);
    expect(w.current()).toBeNull();
  });

  it('stays off when the setting cannot be loaded', async () => {
    const api = fakeApi();
    api.settings.mockRejectedValue(new Error('offline'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const w = new Walkthrough();
    await w.start(api);
    expect(w.active()).toBe(false);
    expect(log).toHaveBeenCalledOnce();
  });

  it('points at each control in turn, and saves once at the end', async () => {
    const { w, api } = await started();
    w.onTrunkReplyReady();
    w.onEnteredTangent();
    expect(w.current()?.target).toBe('[data-coach="main-thread"]');
    // Below the path at the top of the lesson, off the header.
    expect(w.current()?.placement).toBe('bottom');
    expect(w.current()?.text).toBe(WALKTHROUGH_STEPS.back);
    w.onBackOnTrunk();
    expect(w.current()?.target).toBe('[data-action="next"]');
    expect(w.current()?.buttonText).toBe(WALKTHROUGH_BUTTONS.done);
    expect(api.updateSettings).not.toHaveBeenCalled();
    w.next();
    expect(w.current()).toBeNull();
    expect(w.active()).toBe(false);
    w.skip();
    expect(api.updateSettings).toHaveBeenCalledExactlyOnceWith({ walkthroughDone: true });
  });

  it('a reply sent with Next ➜ on step 3 ends it and saves once', async () => {
    const { w, api } = await started();
    w.onTrunkReplyReady();
    w.onRepliedOnTrunk();
    expect(w.current()?.step).toBe(1);
    w.onEnteredTangent();
    w.onBackOnTrunk();
    expect(w.current()?.step).toBe(3);
    w.onRepliedOnTrunk();
    expect(w.active()).toBe(false);
    w.onRepliedOnTrunk();
    expect(api.updateSettings).toHaveBeenCalledExactlyOnceWith({ walkthroughDone: true });
  });

  it('skipping at step 2 saves once', async () => {
    const { w, api } = await started();
    w.onEnteredTangent();
    expect(w.current()?.step).toBe(2);
    w.skip();
    w.skip();
    expect(w.current()).toBeNull();
    expect(api.updateSettings).toHaveBeenCalledExactlyOnceWith({ walkthroughDone: true });
  });

  it('a failed save is logged and the tour stays over', async () => {
    const { w, api } = await started();
    api.updateSettings.mockRejectedValue(new Error('offline'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    w.skip();
    await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
    expect(w.active()).toBe(false);
  });

  it('replays from step 1 without telling the server again', async () => {
    const { w, api } = await started();
    w.skip();
    w.replay();
    expect(w.active()).toBe(true);
    w.onTrunkReplyReady();
    expect(w.current()?.step).toBe(1);
    w.skip();
    expect(api.updateSettings).toHaveBeenCalledTimes(1);
  });

  it('replays for an account that has had it, never saving', async () => {
    const { w, api } = await started('2026-10-01T00:00:00.000Z');
    w.replay();
    w.onEnteredTangent();
    w.onBackOnTrunk();
    w.next();
    expect(w.active()).toBe(false);
    expect(api.updateSettings).not.toHaveBeenCalled();
  });
});
