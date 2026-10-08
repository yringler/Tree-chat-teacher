import { Injectable, signal } from '@angular/core';
import {
  DEFAULT_INPUT_OVERFLOW,
  MAX_REQUESTED_INPUT_TOKENS,
  MAX_REQUESTED_OUTPUT_TOKENS,
  MIN_REQUESTED_INPUT_TOKENS,
  MIN_REQUESTED_OUTPUT_TOKENS,
  type BranchFunding,
  type InputOverflow,
  type ModelTier,
} from '@tangent/shared';

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
 * App-wide preferences. Add new settings here with a default; `read` drops
 * anything malformed field by field, so older or hand-edited data never
 * breaks the app.
 */
export interface AppSettings {
  /** Default model for "Review up to here"; null = the branch's provider default. */
  reviewer: ModelChoice | null;
  /**
   * What the Normal | Max switch (route bar, home page) and Compare use for
   * each tier; null = the suggested model of the tier (TierStore `choice`).
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

const STORAGE_KEY = 'tangent.settings';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function parseChoice(v: unknown): ModelChoice | null {
  if (!isRecord(v)) return null;
  const { providerId, model, funding } = v;
  if (typeof providerId !== 'string' || !providerId || typeof model !== 'string' || !model)
    return null;
  const choice: ModelChoice = { providerId, model };
  if (funding === 'credit' || funding === 'own-key') choice.funding = funding;
  return choice;
}

export function parseSettings(raw: string | null): AppSettings {
  if (!raw) return DEFAULT_SETTINGS;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return DEFAULT_SETTINGS;
  }
  if (!isRecord(value)) return DEFAULT_SETTINGS;
  // Settings saved before the tiers existed have none: both suggested.
  const tiers = isRecord(value['tiers']) ? value['tiers'] : {};
  return {
    ...DEFAULT_SETTINGS,
    reviewer: parseChoice(value['reviewer']),
    tiers: { normal: parseChoice(tiers['normal']), max: parseChoice(tiers['max']) },
    maxOutputTokens: parseOutputTokens(value['maxOutputTokens']),
    maxInputTokens: parseInputTokens(value['maxInputTokens']),
    inputOverflow: value['inputOverflow'] === 'truncate' ? 'truncate' : DEFAULT_INPUT_OVERFLOW,
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

/**
 * Preferences kept in this browser's localStorage. Nothing here is secret
 * (API keys live in the sealed cookie), and the server never needs them:
 * each request names its provider/model explicitly.
 */
@Injectable({ providedIn: 'root' })
export class SettingsStore {
  readonly settings = signal<AppSettings>(this.read());

  update(patch: Partial<AppSettings>): void {
    const next = { ...this.settings(), ...patch };
    this.settings.set(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage unavailable (private mode, blocked): keep the in-memory value.
    }
  }

  private read(): AppSettings {
    try {
      return parseSettings(localStorage.getItem(STORAGE_KEY));
    } catch {
      return DEFAULT_SETTINGS;
    }
  }
}
