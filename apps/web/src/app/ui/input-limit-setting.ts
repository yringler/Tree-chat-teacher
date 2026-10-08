import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  model,
  type OnInit,
  signal,
} from '@angular/core';
import {
  describeTokenSize,
  formatUsdEstimate,
  INPUT_TOKEN_PRESETS,
  inputBudgetOf,
  inputCostUsd,
  MAX_REQUESTED_INPUT_TOKENS,
  MIN_REQUESTED_INPUT_TOKENS,
  WORDS_PER_PAGE,
  type InputBudgetResponse,
  type InputOverflow,
} from '@tangent/shared';
import { ApiClient } from '@tangent/web-shared';
import { parseInputTokens } from '../state/settings-store';
import { TreeStore } from '../state/tree-store';

let uid = 0;

/** What the limit starts at when it is turned on for the first time. */
const DEFAULT_LIMIT_TOKENS = 32_000;

const n = (tokens: number) => tokens.toLocaleString('en-US');
const perMillion = (usd: number) =>
  `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;

/** The setting as the hints see it: the limit (null = off) and the reply length (null = Auto). */
export interface InputLimitState {
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
}

/**
 * The hints under the setting, live as it changes: how big the number in
 * effect is (the limit, or without one the default), what the server would
 * send without a limit on the open conversation's route and model, and what
 * that much input costs: on Tangent credit what credit charges for it, on the
 * own key OpenRouter's list price. `info` null: no
 * conversation is open (or its numbers didn't load), so only the size of a
 * chosen limit shows.
 */
export function inputLimitNotes(
  info: InputBudgetResponse | null,
  state: InputLimitState,
): { size: string | null; route: string | null; cost: string | null } {
  if (!info) {
    const limit = state.maxInputTokens;
    return { size: limit !== null ? describeTokenSize(limit) : null, route: null, cost: null };
  }
  const budget = inputBudgetOf(info, state);
  const route =
    info.serverMaxInputTokens !== null
      ? `${info.funding === 'credit' ? 'On Tangent credit' : 'Here'}, a message sends at most ` +
        `${n(budget.defaultTokens)} tokens (on ${info.model}); a limit of yours can only lower that.`
      : `Without a limit, this conversation's model (${info.model}) takes up to ` +
        `${n(budget.defaultTokens)} tokens a message: its ${n(info.contextTokens)}-token ` +
        `context window less ${n(budget.replyTokens)} for the reply.`;
  const over =
    state.maxInputTokens !== null && budget.boundBy !== 'limit'
      ? ` Your limit is above that, so ${n(budget.tokens)} applies.`
      : '';
  let cost: string | null = null;
  if (info.price) {
    const { inputUsdPerMTok, cacheReadUsdPerMTok, basis } = info.price;
    const full = formatUsdEstimate(inputCostUsd(budget.tokens, inputUsdPerMTok));
    // On credit: what the user pays (billing's list price × fee × markup); on the own key: the
    // list price, which OpenRouter bills directly.
    const at =
      basis === 'credit'
        ? `on Tangent credit, which charges ${perMillion(inputUsdPerMTok)} per million tokens ` +
          `of ${info.model}'s input (OpenRouter's price with its fee and Tangent's markup)`
        : `at ${info.model}'s OpenRouter list price (${perMillion(inputUsdPerMTok)} per million tokens)`;
    cost =
      `A message that sends all ${n(budget.tokens)} tokens costs about ${full} in input ${at}` +
      (cacheReadUsdPerMTok !== null
        ? `, or about ${formatUsdEstimate(inputCostUsd(budget.tokens, cacheReadUsdPerMTok))} ` +
          `when it is read from the prompt cache (${perMillion(cacheReadUsdPerMTok)} per million).`
        : '.') +
      (basis === 'list'
        ? ' OpenRouter bills your key directly, and adds its fee when you buy OpenRouter credit.'
        : '');
  }
  return { size: describeTokenSize(budget.tokens), route: route + over, cost };
}

/**
 * "Input limit": how much of a conversation one message may send, and what
 * happens to a conversation over it. Off (null) is the server's default:
 * the model's window less the reply (on Tangent credit, the server's cap).
 * Bound with `[(value)]`, `[(overflow)]` and `[(invalid)]` (a custom number
 * out of range: `value` keeps the last valid one); `replyTokens` is the
 * dialog's reply length, which the default reserves room for. The dialog
 * saves it. The hints are `inputLimitNotes` for the open conversation.
 */
@Component({
  selector: 'app-input-limit-setting',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <fieldset class="settings-section">
      <legend>Input limit</legend>
      <p class="muted small">
        Each message sends the conversation so far (its branch's path) to the model, and you pay for
        all of it as input. On your own key only the model's context window bounds it, so a long
        conversation can send hundreds of thousands of tokens with every message. Sizes are rough,
        for English: ¾ of a word a token, {{ wordsPerPage }} words a paperback page.
      </p>
      <label class="check">
        <input type="checkbox" [checked]="enabled()" (change)="setEnabled(!enabled())" />
        Limit what each message sends
      </label>
      @if (enabled()) {
        <div class="radio-group input-limit-options" role="radiogroup" aria-label="Input limit">
          @for (p of presets; track p) {
            <label class="radio">
              <input
                type="radio"
                [name]="name"
                [checked]="choice() === p"
                (change)="pickPreset(p)"
              />
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
          <label class="field indent input-limit-custom">
            <span class="field-label">Tokens ({{ format(min) }}–{{ format(max) }})</span>
            <input
              type="number"
              inputmode="numeric"
              [min]="min"
              [max]="max"
              step="1000"
              [value]="customText()"
              (input)="setCustom(box.value)"
              #box
            />
            @if (customError()) {
              <span class="field-error small" role="alert">
                Enter a whole number from {{ format(min) }} to {{ format(max) }}.
              </span>
            }
          </label>
        }
      }
      <div class="input-limit-notes small" aria-live="polite">
        @if (notes().size; as size) {
          <p class="input-limit-size">{{ size }}</p>
        }
        @if (notes().route; as route) {
          <p class="input-limit-route">{{ route }}</p>
        }
        @if (notes().cost; as cost) {
          <p class="input-limit-cost">{{ cost }}</p>
        }
      </div>

      <div class="radio-group input-limit-overflow" role="radiogroup" aria-label="Over the limit">
        <p class="small">When a conversation is longer than the limit (yours, or the model's):</p>
        <label class="radio">
          <input
            type="radio"
            [name]="name + '-overflow'"
            [checked]="overflow() === 'compact'"
            (change)="overflow.set('compact')"
          />
          <span>
            <strong>Summarize the oldest part</strong>
            <span class="muted small">
              A model call writes a summary to stand in for the oldest messages, paid like any call,
              and again whenever the conversation outgrows it. If no summary can be written, or the
              limit leaves no room for one, those messages are left out.
            </span>
          </span>
        </label>
        <label class="radio">
          <input
            type="radio"
            [name]="name + '-overflow'"
            [checked]="overflow() === 'truncate'"
            (change)="overflow.set('truncate')"
          />
          <span>
            <strong>Drop the oldest messages</strong>
            <span class="muted small">
              No summary: nothing extra to pay or wait for, but the model no longer sees them.
            </span>
          </span>
        </label>
      </div>
    </fieldset>
  `,
  styles: `
    .input-limit-options {
      flex-direction: row;
      flex-wrap: wrap;
      gap: 6px 16px;
      margin-top: 6px;
    }
    .input-limit-custom {
      max-width: 220px;
      margin-top: 6px;
    }
    .input-limit-notes p {
      margin: 6px 0 0;
    }
    .input-limit-overflow {
      margin-top: 10px;
    }
    .input-limit-overflow > p {
      margin: 0;
    }
  `,
})
export class InputLimitSetting implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly store = inject(TreeStore);

  /** The limit; null = off (the server's default). */
  readonly value = model<number | null>(null);
  readonly overflow = model<InputOverflow>('compact');
  /** True while the custom box holds no valid number. */
  readonly invalid = model(false);
  /** The reply length chosen in the same dialog (null = Auto): the default reserves room for it. */
  readonly replyTokens = input<number | null>(null);

  protected readonly name = `input-limit-${++uid}`;
  protected readonly presets = INPUT_TOKEN_PRESETS;
  protected readonly min = MIN_REQUESTED_INPUT_TOKENS;
  protected readonly max = MAX_REQUESTED_INPUT_TOKENS;
  protected readonly wordsPerPage = WORDS_PER_PAGE;
  protected readonly format = n;

  /** The open conversation's numbers, once loaded; null without one (or when they fail). */
  protected readonly info = signal<InputBudgetResponse | null>(null);
  /** True once the user picked Custom (a custom value that equals a preset stays custom). */
  private readonly customMode = signal(false);
  /** The custom box's text, once edited. */
  private readonly draft = signal<string | null>(null);
  /** The limit to restore when it is turned back on. */
  private remembered: number | null = null;
  /** On while the box is ticked, even before a valid custom number. */
  private readonly ticked = signal(false);

  protected readonly enabled = computed(() => this.ticked() || this.value() !== null);
  protected readonly customError = computed(() => this.choice() === 'custom' && this.invalid());
  protected readonly customText = computed(() => this.draft() ?? String(this.value() ?? ''));

  protected readonly choice = computed<'custom' | number>(() => {
    const v = this.value();
    if (this.customMode() || v === null) return 'custom';
    return this.presets.includes(v) ? v : 'custom';
  });

  protected readonly notes = computed(() =>
    inputLimitNotes(this.info(), {
      maxInputTokens: this.value(),
      maxOutputTokens: this.replyTokens(),
    }),
  );

  ngOnInit(): void {
    const branch = this.store.selectedBranch();
    if (branch) void this.load(branch.id);
  }

  private async load(branchId: string): Promise<void> {
    try {
      this.info.set(await this.api.inputBudget(branchId));
    } catch {
      // The hints fall back to the size of the number alone.
      this.info.set(null);
    }
  }

  protected setEnabled(on: boolean): void {
    this.leaveCustom();
    this.ticked.set(on);
    if (on) {
      this.value.set(this.value() ?? this.remembered ?? DEFAULT_LIMIT_TOKENS);
    } else {
      this.remembered = this.value() ?? this.remembered;
      this.value.set(null);
    }
  }

  protected pickPreset(tokens: number): void {
    this.leaveCustom();
    this.value.set(tokens);
  }

  protected pickCustom(): void {
    this.customMode.set(true);
    this.setCustom(String(this.value() ?? DEFAULT_LIMIT_TOKENS));
  }

  protected setCustom(text: string): void {
    this.customMode.set(true);
    this.draft.set(text);
    const parsed = parseInputTokens(text.trim() === '' ? NaN : Number(text));
    this.invalid.set(parsed === null);
    if (parsed !== null) this.value.set(parsed);
  }

  private leaveCustom(): void {
    this.customMode.set(false);
    this.draft.set(null);
    this.invalid.set(false);
  }
}
