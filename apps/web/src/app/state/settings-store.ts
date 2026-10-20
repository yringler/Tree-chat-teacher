import { inject, Injectable, signal } from '@angular/core';
import {
  DEFAULT_INPUT_OVERFLOW,
  MAX_REQUESTED_INPUT_TOKENS,
  MAX_REQUESTED_OUTPUT_TOKENS,
  MIN_REQUESTED_INPUT_TOKENS,
  MIN_REQUESTED_OUTPUT_TOKENS,
  type BranchFunding,
  type InputOverflow,
  type ModelTier,
  type SettingsModelChoice,
  type SettingsResponse,
  type UpdateSettingsRequest,
} from '@tangent/shared';
import { ApiClient } from '@tangent/web-shared';

/**
 * A provider + model pair, as stored in settings, with who pays for it
 * (absent = the user's own key).
 */
export interface ModelChoice {
  providerId: string;
  funding?: BranchFunding;
  model: string;
}

/**
 * Power's Settings, kept with the account (`/api/settings`), so every
 * device has the same. The server checks each value and answers the default
 * for one that no longer validates.
 */
export interface AppSettings {
  /**
   * Default model for "Review up to here", kept by its "Use as my default
   * reviewer"; null = the branch's provider default.
   */
  reviewer: ModelChoice | null;
  /**
   * What the Normal | Max switch (route bar, home page) and Compare use for
   * each tier; null = the suggested model of the tier (TierStore `choice`).
   * A new conversation starts on a chosen Normal (TierStore `starting`).
   */
  tiers: Readonly<Record<ModelTier, ModelChoice | null>>;
  /**
   * Output cap of a reply, sent with each message (the server caps it at the
   * model's limit); null = Auto, the server's default for the model (larger
   * for reasoning models, @tangent/shared output-tokens.ts).
   */
  maxOutputTokens: number | null;
  /**
   * Input limit of a message, sent with each one (and with the Context
   * panel's preview); the server keeps it within the model's window, and on
   * Tangent credit within its own cap. null = off: no limit of the user's.
   */
  maxInputTokens: number | null;
  /** What a conversation over its input budget loses (@tangent/shared input-limit.ts). */
  inputOverflow: InputOverflow;
}

export const DEFAULT_SETTINGS: AppSettings = {
  reviewer: null,
  tiers: { normal: null, max: null },
  maxOutputTokens: null,
  maxInputTokens: null,
  inputOverflow: DEFAULT_INPUT_OVERFLOW,
};

/** A choice as the account stores it, which names who pays (absent here means the user's own key). */
export function savedChoice(choice: ModelChoice): SettingsModelChoice {
  return {
    providerId: choice.providerId,
    funding: choice.funding ?? 'own-key',
    model: choice.model,
  };
}

/** A whole number of tokens a send may ask for, else null (Auto). */
export function parseOutputTokens(v: unknown): number | null {
  return typeof v === 'number' &&
    Number.isInteger(v) &&
    v >= MIN_REQUESTED_OUTPUT_TOKENS &&
    v <= MAX_REQUESTED_OUTPUT_TOKENS
    ? v
    : null;
}

/** A whole number of tokens a message's input may be limited to, else null (no limit). */
export function parseInputTokens(v: unknown): number | null {
  return typeof v === 'number' &&
    Number.isInteger(v) &&
    v >= MIN_REQUESTED_INPUT_TOKENS &&
    v <= MAX_REQUESTED_INPUT_TOKENS
    ? v
    : null;
}

/**
 * What a send (or the Context preview) carries of the settings: only what
 * differs from the server's defaults.
 */
export function generationLimits(settings: AppSettings): {
  maxOutputTokens?: number;
  maxInputTokens?: number;
  inputOverflow?: InputOverflow;
} {
  const { maxOutputTokens, maxInputTokens, inputOverflow } = settings;
  return {
    ...(maxOutputTokens !== null ? { maxOutputTokens } : {}),
    ...(maxInputTokens !== null ? { maxInputTokens } : {}),
    ...(inputOverflow !== DEFAULT_INPUT_OVERFLOW ? { inputOverflow } : {}),
  };
}

/** The account's default system prompt: as saved (null = the built-in one), and the built-in one. */
export interface SavedPrompt {
  saved: string | null;
  builtIn: string;
}

/**
 * Power's Settings and default system prompt, as the account keeps them.
 * `TreeStore.init` loads them; until then `settings` holds the defaults and
 * `loaded` is false, so what sends with them waits for `load()` and what
 * shows them (Normal and Max) shows nothing yet rather than the defaults.
 */
@Injectable({ providedIn: 'root' })
export class SettingsStore {
  private readonly api = inject(ApiClient);
  readonly settings = signal<AppSettings>(DEFAULT_SETTINGS);
  readonly prompt = signal<SavedPrompt>({ saved: null, builtIn: '' });
  readonly loaded = signal(false);
  private loading: Promise<void> | null = null;
  /** The saves in flight, one after another, so their answers apply in the order they were made. */
  private saves: Promise<void> = Promise.resolve();

  /** Loads the settings once; after a failed load the next call tries again. */
  load(): Promise<void> {
    if (this.loaded()) return Promise.resolve();
    this.loading ??= this.fetch();
    return this.loading;
  }

  /**
   * Saves the fields `request` names, all or none, and takes the account's
   * answer, which also brings what another device saved since. Rejects when
   * the server refuses or can't be reached; nothing changes then.
   */
  async save(request: UpdateSettingsRequest): Promise<void> {
    const run = this.saves.then(async () => {
      // A load answering after the save would put the old values back.
      await this.load();
      this.apply(await this.api.updateSettings(request));
    });
    this.saves = run.catch(() => undefined);
    await run;
  }

  private async fetch(): Promise<void> {
    try {
      this.apply(await this.api.settings());
    } catch (err) {
      this.loading = null;
      throw err;
    }
  }

  private apply(res: SettingsResponse): void {
    this.settings.set({
      reviewer: res.reviewer,
      tiers: res.tiers,
      maxOutputTokens: res.maxOutputTokens,
      maxInputTokens: res.maxInputTokens,
      inputOverflow: res.inputOverflow,
    });
    this.prompt.set({ saved: res.systemPrompt, builtIn: res.defaultSystemPrompt });
    this.loaded.set(true);
  }
}
