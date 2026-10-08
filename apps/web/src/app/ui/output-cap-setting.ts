import { ChangeDetectionStrategy, Component, computed, input, model, signal } from '@angular/core';
import {
  BUILT_IN_MAX_OUTPUT_TOKENS,
  formatTokenCount,
  isReasoningModel,
  MAX_REQUESTED_OUTPUT_TOKENS,
  MIN_REQUESTED_OUTPUT_TOKENS,
  OUTPUT_TOKEN_PRESETS,
  replyOutputTokens,
  type ProviderInfo,
} from '@tangent/shared';
import { parseOutputTokens } from '../state/settings-store';

let uid = 0;

/** What Custom starts from when Auto was chosen. */
const DEFAULT_CUSTOM_TOKENS = 12_000;

/** The model a hint is about: the open conversation's branch, with its provider entry. */
export interface OutputCapModel {
  model: string;
  provider: ProviderInfo | undefined;
}

/** What a send on `target` would be capped at, and why; see `replyOutputTokens`. */
export function effectiveOutputCap(
  chosen: number | null,
  target: OutputCapModel,
): { tokens: number; reasoning: boolean; limit: number | null } {
  const info = target.provider?.models.find((m) => m.id === target.model);
  const reasoning = info?.reasoning ?? isReasoningModel(target.model);
  const limits = [
    info?.maxOutputTokens,
    target.provider?.funding === 'credit' ? BUILT_IN_MAX_OUTPUT_TOKENS : undefined,
  ].filter((n): n is number => n !== undefined);
  const limit = limits.length > 0 ? Math.min(...limits) : null;
  const tokens = replyOutputTokens({
    reasoning,
    maxOutputTokens: limit ?? Number.MAX_SAFE_INTEGER,
    requested: chosen,
  });
  return { tokens, reasoning, limit };
}

/**
 * "Reply length": the output cap power sends with each message. Auto (null)
 * is the server's default for the model, larger for reasoning models, whose
 * hidden thinking counts against the cap; a preset or a custom number
 * replaces it. Bound with `[(value)]` and `[(invalid)]` (a custom number out
 * of range: `value` keeps the last valid one); the dialog saves it.
 */
@Component({
  selector: 'app-output-cap-setting',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <fieldset class="settings-section">
      <legend>Reply length</legend>
      <p class="muted small">
        The most tokens a reply may use. Models that reason before answering spend part of it on
        thinking you don't see, so a low limit can cut a reply short, or leave it empty. You pay
        only for what a reply uses. Each model's own limit still applies (on Tangent credit,
        {{ creditMax }}).
      </p>
      <div class="radio-group output-cap-options" role="radiogroup" aria-label="Reply length">
        <label class="radio">
          <input type="radio" [name]="name" [checked]="choice() === 'auto'" (change)="pickAuto()" />
          <span>
            <strong>Auto</strong>
            <span class="muted small">4k, or 16k for a model that reasons.</span>
          </span>
        </label>
        @for (p of presets; track p) {
          <label class="radio">
            <input type="radio" [name]="name" [checked]="choice() === p" (change)="pickPreset(p)" />
            <span
              ><strong>{{ format(p) }}</strong></span
            >
          </label>
        }
        <label class="radio">
          <input
            type="radio"
            [name]="name"
            [checked]="choice() === 'custom'"
            (change)="pickCustom()"
          />
          <span><strong>Custom</strong></span>
        </label>
      </div>
      @if (choice() === 'custom') {
        <label class="field indent output-cap-custom">
          <span class="field-label">Tokens ({{ min }}–{{ maxLabel }})</span>
          <input
            type="number"
            inputmode="numeric"
            [min]="min"
            [max]="max"
            step="1024"
            [value]="customText()"
            (input)="setCustom(box.value)"
            #box
          />
          @if (customError()) {
            <span class="field-error small" role="alert">
              Enter a whole number from {{ min }} to {{ maxLabel }}.
            </span>
          }
        </label>
      }
      @if (hint(); as h) {
        <p class="small output-cap-hint">{{ h }}</p>
      }
    </fieldset>
  `,
  styles: `
    .output-cap-options {
      flex-direction: row;
      flex-wrap: wrap;
      gap: 6px 16px;
    }
    .output-cap-custom {
      max-width: 220px;
      margin-top: 6px;
    }
    .output-cap-hint {
      margin: 6px 0 0;
    }
  `,
})
export class OutputCapSetting {
  /** The chosen cap; null = Auto. */
  readonly value = model<number | null>(null);
  /** True while the custom box holds no valid number. */
  readonly invalid = model(false);
  /** The open conversation's model, for the "this conversation" hint; null = none open. */
  readonly target = input<OutputCapModel | null>(null);

  protected readonly name = `output-cap-${++uid}`;
  protected readonly presets = OUTPUT_TOKEN_PRESETS;
  protected readonly min = MIN_REQUESTED_OUTPUT_TOKENS;
  protected readonly max = MAX_REQUESTED_OUTPUT_TOKENS;
  protected readonly maxLabel = MAX_REQUESTED_OUTPUT_TOKENS.toLocaleString('en-US');
  protected readonly creditMax = formatTokenCount(BUILT_IN_MAX_OUTPUT_TOKENS);
  protected readonly format = formatTokenCount;

  /** True once the user picked Custom (a custom value that equals a preset stays custom). */
  private readonly customMode = signal(false);
  /** The custom box's text, once edited. */
  private readonly draft = signal<string | null>(null);
  protected readonly customError = computed(() => this.choice() === 'custom' && this.invalid());
  protected readonly customText = computed(() => this.draft() ?? String(this.value() ?? ''));

  protected readonly choice = computed<'auto' | 'custom' | number>(() => {
    const v = this.value();
    if (this.customMode()) return 'custom';
    if (v === null) return 'auto';
    return this.presets.includes(v) ? v : 'custom';
  });

  protected readonly hint = computed(() => {
    const target = this.target();
    if (!target) return null;
    const { tokens, reasoning, limit } = effectiveOutputCap(this.value(), target);
    const chosen = this.value();
    const capped = chosen !== null && limit !== null && chosen > limit;
    const kind = reasoning ? 'reasons before answering' : "doesn't reason";
    return (
      `This conversation's model (${target.model}) ${kind}: its replies get up to ` +
      `${formatTokenCount(tokens)} tokens${capped ? ', its limit' : ''}.`
    );
  });

  protected pickAuto(): void {
    this.leaveCustom();
    this.value.set(null);
  }

  protected pickPreset(tokens: number): void {
    this.leaveCustom();
    this.value.set(tokens);
  }

  protected pickCustom(): void {
    this.customMode.set(true);
    this.setCustom(String(this.value() ?? DEFAULT_CUSTOM_TOKENS));
  }

  protected setCustom(text: string): void {
    this.customMode.set(true);
    this.draft.set(text);
    const parsed = parseOutputTokens(text.trim() === '' ? NaN : Number(text));
    this.invalid.set(parsed === null);
    if (parsed !== null) this.value.set(parsed);
  }

  private leaveCustom(): void {
    this.customMode.set(false);
    this.draft.set(null);
    this.invalid.set(false);
  }
}
