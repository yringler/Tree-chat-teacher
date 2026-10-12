import { computed, Injectable, signal, type Signal } from '@angular/core';
import { WALKTHROUGH_BUTTONS, WALKTHROUGH_STEPS } from '@tangent/shared';
import { errorMessage, type ApiClient } from '../core/api-client';

/** The server calls the walkthrough makes: whether the account has had it, and saying it has. */
export type WalkthroughApi = Pick<ApiClient, 'settings' | 'updateSettings'>;

/**
 * Where the first-run walkthrough is. `off`: not started (or the account
 * has had it); `done`: finished or skipped here. Each step is `shown` once
 * the screen has what it points at, else it waits for the learner to get
 * there (a lesson with no reply yet, a tangent not yet entered).
 */
export type WalkthroughState =
  | { readonly step: 'off' }
  | { readonly step: 'done' }
  | { readonly step: 1 | 2 | 3; readonly shown: boolean };

/** What the app tells the walkthrough about the screen, and what the learner does with it. */
export type WalkthroughEvent =
  'start' | 'trunkReplyReady' | 'enteredTangent' | 'backOnTrunk' | 'next' | 'skip';

export const WALKTHROUGH_OFF: WalkthroughState = { step: 'off' };

/**
 * The walkthrough's one rule, pure: the loop of going on a tangent, heading
 * back and replying, each step shown when the learner reaches it.
 * - Step 1 (Tangent ↳) waits for a reply on the main thread.
 * - Step 2 (back to the main thread) shows inside any tangent, however it
 *   was entered; entering one before step 1 showed skips straight to it.
 * - Step 3 (Next ➜) shows back on the main thread after step 2.
 * "Got it" puts a step away and waits for the next one; Done on step 3 and
 * Skip end it.
 */
export function walkthroughStep(s: WalkthroughState, e: WalkthroughEvent): WalkthroughState {
  if (e === 'start') return { step: 1, shown: false };
  if (s.step === 'off' || s.step === 'done') return s;
  switch (e) {
    case 'skip':
      return { step: 'done' };
    case 'next':
      if (!s.shown) return s;
      return s.step === 3 ? { step: 'done' } : { step: s.step === 1 ? 2 : 3, shown: false };
    case 'trunkReplyReady':
      return s.step === 1 ? { step: 1, shown: true } : s;
    case 'enteredTangent':
      return s.step === 1 || (s.step === 2 && !s.shown) ? { step: 2, shown: true } : s;
    case 'backOnTrunk':
      return (s.step === 2 && s.shown) || (s.step === 3 && !s.shown) ? { step: 3, shown: true } : s;
  }
}

/** One coach mark on screen: what it says, what it points at, and its button. */
export interface CoachStep {
  readonly step: 1 | 2 | 3;
  readonly text: string;
  /** CSS selector of the control it points at. */
  readonly target: string;
  readonly buttonText: string;
  readonly skipText: string;
}

const STEPS: Readonly<Record<1 | 2 | 3, Omit<CoachStep, 'step' | 'skipText'>>> = {
  1: {
    text: WALKTHROUGH_STEPS.tangent,
    target: '[data-action="tangent"]',
    buttonText: WALKTHROUGH_BUTTONS.next,
  },
  2: {
    text: WALKTHROUGH_STEPS.back,
    target: '[data-coach="main-thread"]',
    buttonText: WALKTHROUGH_BUTTONS.next,
  },
  3: {
    text: WALKTHROUGH_STEPS.next,
    target: '[data-action="next"]',
    buttonText: WALKTHROUGH_BUTTONS.done,
  },
};

/**
 * The first-run walkthrough of Learn: three coach marks that take the
 * learner once round the loop (tangent, back, reply). It runs while the
 * account's `walkthroughDoneAt` is null, and finishing or skipping it saves
 * that on the server once, so it never comes back on another device or in
 * the phone app. The app reports the screen (`onTrunkReplyReady`,
 * `onEnteredTangent`, `onBackOnTrunk`); `CoachMark` shows `current`.
 */
@Injectable({ providedIn: 'root' })
export class Walkthrough {
  private readonly state = signal<WalkthroughState>(WALKTHROUGH_OFF);
  private api: WalkthroughApi | null = null;
  /** The server knows the account has had it: nothing more to save. */
  private saved = false;

  /** The coach mark to show, or null. */
  readonly current: Signal<CoachStep | null> = computed(() => {
    const s = this.state();
    if (s.step === 'off' || s.step === 'done' || !s.shown) return null;
    return { step: s.step, ...STEPS[s.step], skipText: WALKTHROUGH_BUTTONS.skip };
  });

  /** Running, shown or waiting for the learner. */
  readonly active = computed(() => {
    const step = this.state().step;
    return step !== 'off' && step !== 'done';
  });

  /**
   * Starts the walkthrough if the account hasn't had it. Asks the server
   * once; later calls (another lesson opened) do nothing. A failed load
   * leaves it off: a tour is never worth an error.
   */
  async start(api: WalkthroughApi): Promise<void> {
    if (this.api) return;
    this.api = api;
    try {
      const settings = await api.settings();
      if (settings.walkthroughDoneAt === null) this.dispatch('start');
      else this.saved = true;
    } catch (err) {
      console.error('Could not load the walkthrough setting:', errorMessage(err));
    }
  }

  /** The main thread has a complete reply, with Tangent ↳ under it. */
  onTrunkReplyReady(): void {
    this.dispatch('trunkReplyReady');
  }

  /** The open branch is a tangent. */
  onEnteredTangent(): void {
    this.dispatch('enteredTangent');
  }

  /** The open branch is the main thread again. */
  onBackOnTrunk(): void {
    this.dispatch('backOnTrunk');
  }

  /** "Got it" (or Done on the last step). */
  next(): void {
    this.dispatch('next');
  }

  /** "Skip tour" or Escape. */
  skip(): void {
    this.dispatch('skip');
  }

  /**
   * From the help sheet: once more from step 1. The server is told only if
   * it hasn't been yet (a replay of the first run still in progress).
   */
  replay(): void {
    this.dispatch('start');
  }

  private dispatch(e: WalkthroughEvent): void {
    const next = walkthroughStep(this.state(), e);
    this.state.set(next);
    if (next.step === 'done') this.save();
  }

  private save(): void {
    if (this.saved || !this.api) return;
    this.saved = true;
    this.api.updateSettings({ walkthroughDone: true }).catch((err: unknown) => {
      console.error('Could not save the walkthrough as done:', errorMessage(err));
    });
  }
}
