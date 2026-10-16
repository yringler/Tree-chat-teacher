import { computed, Injectable, signal } from '@angular/core';
import {
  LEARN_KEY_PROVIDERS,
  MODE_HEADER,
  OPENROUTER_PROVIDER_ID,
  OWN_KEY_HEADER,
  PAYERS,
  PAYMENT_HEADER,
  type LearnKeyProvider,
  type Payer,
} from '@tangent/shared';

const STORAGE_KEY = 'tangent.learn.payment';
const OWN_KEY_STORAGE_KEY = 'tangent.learn.ownKey';

function stored<T extends string>(key: string, values: readonly T[]): T | null {
  try {
    const v = localStorage.getItem(key);
    return values.find((p) => p === v) ?? null;
  } catch {
    return null;
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the choice lasts for this page.
  }
}

/**
 * The learner's picks of who pays and of which own key (both remembered in
 * this browser) and what every API call names (API_HEADERS, see
 * app.config.ts): the mode header that makes the server generate as Learn
 * does, the payer, and the own key. LearnFunding resolves the payer from the
 * picks and what it knows (`resolveWith`); it calls the API, which reads
 * these headers, so this holder is what keeps the two apart.
 */
@Injectable({ providedIn: 'root' })
export class PaymentChoice {
  /** The learner's own pick; null until they make one. */
  readonly chosen = signal<Payer | null>(stored(STORAGE_KEY, PAYERS));
  /** Which own key the learner picked; null until they pick one (OpenRouter). */
  readonly chosenKey = signal<LearnKeyProvider | null>(
    stored(OWN_KEY_STORAGE_KEY, LEARN_KEY_PROVIDERS),
  );
  /**
   * The own key every call names: the pick (OpenRouter until there is one),
   * whether or not the key status has been read. The server replaces a key
   * it doesn't offer with OpenRouter, so a status still loading, or one that
   * failed, never moves the learner off the key they picked.
   */
  readonly requestedKey = computed<LearnKeyProvider>(
    () => this.chosenKey() ?? OPENROUTER_PROVIDER_ID,
  );
  private payer: () => Payer = () => this.chosen() ?? 'own-key';

  /** The payer the calls name from now on. */
  resolveWith(payer: () => Payer): void {
    this.payer = payer;
  }

  choose(payer: Payer): void {
    this.chosen.set(payer);
    remember(STORAGE_KEY, payer);
  }

  chooseKey(key: LearnKeyProvider): void {
    this.chosenKey.set(key);
    remember(OWN_KEY_STORAGE_KEY, key);
  }

  /** Headers for every API call of the Learn app. */
  headers(): Record<string, string> {
    return {
      [MODE_HEADER]: 'simple',
      [PAYMENT_HEADER]: this.payer(),
      [OWN_KEY_HEADER]: this.requestedKey(),
    };
  }
}
