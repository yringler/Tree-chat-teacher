import { computed, Injectable, signal } from '@angular/core';

/**
 * Text size steps for the conversation (messages and composer), as factors of
 * the app's base size. A short ladder rather than free numbers: each step is a
 * visible change, and A−/A+ always land on a value the CSS was checked at.
 */
export const TEXT_SIZE_STEPS: readonly number[] = [0.85, 0.92, 1, 1.12, 1.25, 1.4];
export const DEFAULT_TEXT_SIZE = 1;

const STORAGE_KEY = 'tangent.chatFontScale';

/** A stored value back to a step; anything else (missing, garbage, an old step) is the default. */
export function parseTextSize(raw: string | null): number {
  if (raw === null) return DEFAULT_TEXT_SIZE;
  const value = Number(raw);
  return TEXT_SIZE_STEPS.find((s) => Math.abs(s - value) < 0.001) ?? DEFAULT_TEXT_SIZE;
}

/**
 * Text size of the conversation body, kept in this browser. ChatPage sets it
 * as `--chat-font-scale`; chat.css scales the messages and composer from it,
 * while the sidebar, header and dialogs keep their size. Read synchronously,
 * so the first render already has the saved size.
 */
@Injectable({ providedIn: 'root' })
export class TextSizeStore {
  readonly scale = signal(this.read());
  private readonly index = computed(() => TEXT_SIZE_STEPS.indexOf(this.scale()));
  /** E.g. "112%". */
  readonly label = computed(() => `${Math.round(this.scale() * 100)}%`);
  readonly canDecrease = computed(() => this.index() > 0);
  readonly canIncrease = computed(() => this.index() < TEXT_SIZE_STEPS.length - 1);
  readonly isDefault = computed(() => this.scale() === DEFAULT_TEXT_SIZE);

  increase(): void {
    this.set(
      TEXT_SIZE_STEPS[Math.min(this.index() + 1, TEXT_SIZE_STEPS.length - 1)] ?? DEFAULT_TEXT_SIZE,
    );
  }

  decrease(): void {
    this.set(TEXT_SIZE_STEPS[Math.max(this.index() - 1, 0)] ?? DEFAULT_TEXT_SIZE);
  }

  reset(): void {
    this.set(DEFAULT_TEXT_SIZE);
  }

  private set(scale: number): void {
    this.scale.set(scale);
    try {
      if (scale === DEFAULT_TEXT_SIZE) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, String(scale));
    } catch {
      // Storage unavailable (private mode, blocked): keep the in-memory value.
    }
  }

  private read(): number {
    try {
      return parseTextSize(localStorage.getItem(STORAGE_KEY));
    } catch {
      return DEFAULT_TEXT_SIZE;
    }
  }
}
