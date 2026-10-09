import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  type OnInit,
  signal,
  type WritableSignal,
} from '@angular/core';
import {
  MAX_SYSTEM_PROMPT_CHARS,
  maxUsageNote,
  type InputOverflow,
  type ModelTier,
  parseRouteKey,
  providerRouteKey,
  routeKey,
  TIER_LABELS,
  TIERS,
} from '@tangent/shared';
import { ReviewStore } from '../state/review-store';
import { type ModelChoice, SettingsStore } from '../state/settings-store';
import { TierStore } from '../state/tier-store';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { ApiClient, errorMessage, Modal, ToastStore } from '@tangent/web-shared';
import { ModelPicker } from '../ui/model-picker';
import { InputLimitSetting } from '../ui/input-limit-setting';
import { OutputCapSetting, type OutputCapModel } from '../ui/output-cap-setting';

/** One tier in the "Normal & Max" section: the suggested model, or the user's own pick. */
interface TierRow {
  tier: ModelTier;
  label: string;
  suggested: WritableSignal<boolean>;
  /** The pick's provider and funding, as a `routeKey`. */
  route: WritableSignal<string>;
  modelId: WritableSignal<string>;
}

/**
 * App-wide preferences, one section per feature. The default system prompt
 * is saved to the account (server-side, `/api/settings`); the reviewer and
 * the models of Normal and Max, the reply length and the input limit are
 * saved in this browser.
 */
@Component({
  selector: 'app-settings-dialog',
  imports: [Modal, ModelPicker, OutputCapSetting, InputLimitSetting],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal heading="Settings" (closed)="close()">
      <form class="form" (submit)="$event.preventDefault(); save()">
        <fieldset class="settings-section">
          <legend>Default system prompt</legend>
          <p class="muted small">
            New conversations start with this prompt. A conversation's own prompt (Conversation
            settings) replaces it for that conversation. Saved to your account, on every device.
          </p>
          @if (promptError(); as err) {
            <p class="small" role="alert">Couldn't load it: {{ err }}</p>
          } @else {
            <p class="small">
              @if (!promptLoaded()) {
                Loading…
              } @else if (usesBuiltIn()) {
                Now: the built-in prompt. It answers directly, then suggests tangents to branch
                into.
              } @else {
                Now: your own prompt.
              }
            </p>
            <label class="field">
              <span class="sr-only">Default system prompt</span>
              <textarea
                rows="10"
                [attr.maxlength]="maxChars"
                placeholder="Empty: use the built-in prompt"
                [disabled]="!promptLoaded()"
                [value]="systemPrompt()"
                (input)="systemPrompt.set(sp.value)"
                #sp
              ></textarea>
            </label>
            <div class="settings-buttons">
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                [disabled]="!promptLoaded()"
                title="Copy the built-in prompt into the box, to edit it"
                (click)="useDefault()"
              >
                Use default
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                [disabled]="!promptLoaded() || systemPrompt() === ''"
                title="Empty the box: new conversations get the built-in prompt"
                (click)="systemPrompt.set('')"
              >
                Reset to built-in
              </button>
            </div>
          }
        </fieldset>

        <fieldset class="settings-section">
          <legend>Reviewer</legend>
          <p class="muted small">
            “Review” on an assistant message sends the conversation up to that message to this
            model. It points out mistakes and says whether to continue on a stronger model. Pick a
            more capable model than the one you chat with. You can still choose another model for
            each review.
          </p>
          @if (custom()) {
            <app-model-picker [(route)]="route" [(modelId)]="modelId" />
            <button type="button" class="btn btn-ghost btn-sm" (click)="custom.set(false)">
              Use the branch's provider default instead
            </button>
          } @else {
            <p class="small">Now: the default model of the branch's own provider.</p>
            <button type="button" class="btn btn-ghost btn-sm" (click)="customize()">
              Choose a model
            </button>
          }
        </fieldset>

        <fieldset class="settings-section">
          <legend>Normal &amp; Max</legend>
          <p class="muted small">
            The Normal | Max switch under the message box uses these, and Compare asks both. Each
            tier keeps who pays for the branch where it can.
            @if (maxSuggested()) {
              {{ maxNote() }}
            }
          </p>
          @for (row of tierRows; track row.tier) {
            <div class="tier-setting">
              <label class="check">
                <input
                  type="checkbox"
                  [checked]="row.suggested()"
                  (change)="setSuggested(row, !row.suggested())"
                />
                {{ row.label }}: use the suggested model
              </label>
              @if (row.suggested()) {
                <p class="small indent">Now: {{ suggestion(row.tier) }}</p>
              } @else {
                <app-model-picker [(route)]="row.route" [(modelId)]="row.modelId" />
              }
            </div>
          }
        </fieldset>
        <app-output-cap-setting
          [(value)]="outputCap"
          [(invalid)]="outputCapInvalid"
          [target]="outputCapTarget()"
        />
        <app-input-limit-setting
          [(value)]="inputLimit"
          [(overflow)]="inputOverflow"
          [(invalid)]="inputLimitInvalid"
          [replyTokens]="outputCap()"
        />

        <div class="form-actions">
          <button type="button" class="btn btn-ghost" (click)="close()">Cancel</button>
          <button
            type="submit"
            class="btn btn-primary"
            [disabled]="saving() || outputCapInvalid() || inputLimitInvalid()"
          >
            {{ saving() ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </form>
    </app-modal>
  `,
})
export class SettingsDialog implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly settings = inject(SettingsStore);
  private readonly reviews = inject(ReviewStore);
  private readonly store = inject(TreeStore);
  private readonly tiers = inject(TierStore);
  private readonly ui = inject(UiStore);
  private readonly toast = inject(ToastStore);

  protected readonly tierRows: readonly TierRow[] = TIERS.map((tier) => ({
    tier,
    label: TIER_LABELS[tier],
    suggested: signal(true),
    route: signal(''),
    modelId: signal(''),
  }));
  protected readonly maxSuggested = computed(() =>
    this.tierRows.every((row) => row.tier !== 'max' || row.suggested()),
  );
  protected readonly maxNote = computed(() =>
    maxUsageNote(this.tiers.usageFactor(this.store.selectedBranch())),
  );

  protected readonly custom = signal(false);
  /** The reviewer's provider and funding, as a `routeKey`. */
  protected readonly route = signal('');
  protected readonly modelId = signal('');

  /** Reply length (`AppSettings.maxOutputTokens`); null = Auto. */
  protected readonly outputCap = signal<number | null>(null);
  protected readonly outputCapInvalid = signal(false);
  /** Input limit (`AppSettings.maxInputTokens`, null = off) and what happens over it. */
  protected readonly inputLimit = signal<number | null>(null);
  protected readonly inputOverflow = signal<InputOverflow>('compact');
  protected readonly inputLimitInvalid = signal(false);
  /** The open conversation's model, for the reply-length hint. */
  protected readonly outputCapTarget = computed<OutputCapModel | null>(() => {
    const branch = this.store.selectedBranch();
    return branch ? { model: branch.model, provider: this.store.account.providerOf(branch) } : null;
  });

  protected readonly maxChars = MAX_SYSTEM_PROMPT_CHARS;
  /** The editor's text; empty means the built-in prompt. */
  protected readonly systemPrompt = signal('');
  /** What the account has saved (null = the built-in prompt), once loaded. */
  private readonly savedPrompt = signal<string | null>(null);
  /** The server's built-in prompt, exactly as it would use it. */
  private readonly defaultPrompt = signal('');
  protected readonly promptLoaded = signal(false);
  protected readonly promptError = signal<string | null>(null);
  protected readonly saving = signal(false);
  /** What saving the editor would store: blank, or the built-in text unchanged, is the built-in prompt. */
  private readonly promptToSave = computed(() => {
    const text = this.systemPrompt();
    return text.trim() === '' || text.trim() === this.defaultPrompt().trim() ? null : text;
  });
  protected readonly usesBuiltIn = computed(() => this.promptToSave() === null);

  ngOnInit(): void {
    this.outputCap.set(this.settings.settings().maxOutputTokens);
    this.inputLimit.set(this.settings.settings().maxInputTokens);
    this.inputOverflow.set(this.settings.settings().inputOverflow);
    const saved = this.settings.settings().reviewer;
    this.custom.set(saved !== null);
    if (saved) {
      this.route.set(routeKey(saved));
      this.modelId.set(saved.model);
    }
    const tiers = this.settings.settings().tiers;
    for (const row of this.tierRows) {
      const own = tiers[row.tier];
      row.suggested.set(own === null);
      if (own) this.pick(row, own);
    }
    void this.loadPrompt();
  }

  /** What a suggested tier is now, for the open branch: "model (provider)". */
  protected suggestion(tier: ModelTier): string {
    const c = this.tiers.suggested(tier, this.store.selectedBranch());
    if (!c) return 'none (no provider lists one)';
    const provider = this.store.account.providerOf(c)?.label ?? c.providerId;
    return `${this.tiers.modelLabel(c)} (${provider})`;
  }

  /** Unticking "suggested" starts the picker on the tier's model now. */
  protected setSuggested(row: TierRow, suggested: boolean): void {
    if (!suggested && !row.route()) {
      const start = this.tiers.choice(row.tier, this.store.selectedBranch());
      if (start) this.pick(row, start);
    }
    row.suggested.set(suggested);
  }

  private pick(row: TierRow, choice: ModelChoice): void {
    row.route.set(routeKey(choice));
    row.modelId.set(choice.model);
  }

  /** A row's saved value: null while suggested, or when the pick is incomplete. */
  private tierChoice(row: TierRow): ModelChoice | null {
    const model = row.modelId().trim();
    return row.suggested() || !row.route() || !model
      ? null
      : { ...parseRouteKey(row.route()), model };
  }

  private async loadPrompt(): Promise<void> {
    try {
      const res = await this.api.settings();
      this.savedPrompt.set(res.systemPrompt);
      this.defaultPrompt.set(res.defaultSystemPrompt);
      this.systemPrompt.set(res.systemPrompt ?? '');
      this.promptLoaded.set(true);
    } catch (err) {
      this.promptError.set(errorMessage(err));
    }
  }

  /** Copies the built-in prompt into the editor, to start from it. */
  protected useDefault(): void {
    this.systemPrompt.set(this.defaultPrompt());
  }

  protected customize(): void {
    if (!this.route()) {
      const start = this.reviews.defaultReviewer(this.store.selectedBranch());
      const fallback = this.store.account.defaultProvider();
      this.route.set(start ? routeKey(start) : fallback ? providerRouteKey(fallback) : '');
      this.modelId.set(start?.model ?? fallback?.defaultModel ?? '');
    }
    this.custom.set(true);
  }

  protected close(): void {
    this.ui.dialogs.close('settings');
  }

  protected async save(): Promise<void> {
    const reviewer =
      this.custom() && this.route() && this.modelId().trim()
        ? { ...parseRouteKey(this.route()), model: this.modelId().trim() }
        : null;
    if (this.outputCapInvalid() || this.inputLimitInvalid()) return;
    const [normal, max] = this.tierRows.map((row) => this.tierChoice(row));
    this.settings.update({
      reviewer,
      tiers: { normal: normal ?? null, max: max ?? null },
      maxOutputTokens: this.outputCap(),
      maxInputTokens: this.inputLimit(),
      inputOverflow: this.inputOverflow(),
    });
    const prompt = this.promptToSave();
    if (this.promptLoaded() && prompt !== this.savedPrompt()) {
      this.saving.set(true);
      try {
        const res = await this.api.updateSettings({ systemPrompt: prompt });
        this.savedPrompt.set(res.systemPrompt);
      } catch (err) {
        this.store.fail(err);
        return; // keep the dialog (and the edit) open
      } finally {
        this.saving.set(false);
      }
    }
    this.toast.notify('Settings saved');
    this.close();
  }
}
