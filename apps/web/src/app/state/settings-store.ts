import { Injectable, signal } from '@angular/core';
import { fromLegacyRoute, type BranchFunding } from '@tangent/shared';

/**
 * A provider + model pair, as stored in settings, with who pays for it
 * (absent = the user's own key). Choices saved before funding was split from
 * the provider name the legacy `tangent`: read as `openrouter` on credit.
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
}

export const DEFAULT_SETTINGS: AppSettings = {
  reviewer: null,
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
  return fromLegacyRoute(choice);
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
  return { ...DEFAULT_SETTINGS, reviewer: parseChoice(value['reviewer']) };
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
