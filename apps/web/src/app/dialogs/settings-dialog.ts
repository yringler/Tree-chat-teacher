import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  input,
  type OnInit,
  signal,
  viewChild,
  type WritableSignal,
} from '@angular/core';
import {
  MAX_SYSTEM_PROMPT_CHARS,
  maxUsageNote,
  type InputOverflow,
  type ModelTier,
  parseRouteKey,
  routeKey,
  TIER_LABELS,
  TIERS,
} from '@tangent/shared';
import { type AppSettings, type ModelChoice, SettingsStore } from '../state/settings-store';
import { TierStore } from '../state/tier-store';
import { TreeStore } from '../state/tree-store';
import { type SettingsSection, UiStore } from '../state/ui-store';
import { ApiClient, errorMessage, Modal, ToastStore } from '@tangent/web-shared';
import { ModelPicker } from '../ui/model-picker';
import { InputLimitSetting } from '../ui/input-limit-setting';
import { OutputCapSetting, type OutputCapModel } from '../ui/output-cap-setting';

let uid = 0;

/** One tier in "Normal and Max": the suggested model, or the user's own pick. */
interface TierRow {
  tier: ModelTier;
  label: string;
  suggested: WritableSignal<boolean>;
  /** The pick's provider and funding, as a `routeKey`. */
  route: WritableSignal<string>;
  modelId: WritableSignal<string>;
}

/**
 * Defaults for every conversation in power, grouped by what they control,
 * each saying where it is saved: Normal and Max; how replies are written
 * (the default system prompt, saved to the account through `/api/settings`,
 * and the reply limit); what each message sends (the input limit). All but
 * the prompt are saved in this browser (`SettingsStore`). Opened at a
 * section (`section`), it shows that one and focuses its first choice; else
 * it opens at its top.
 */
@Component({
  selector: 'app-settings-dialog',
  imports: [Modal, ModelPicker, OutputCapSetting, InputLimitSetting],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal heading="Settings" [focusHeading]="true" [openAt]="openAt()" (closed)="close()">
      <p class="muted small settings-intro">Defaults for every conversation in power.</p>
      <form class="form" (submit)="$event.preventDefault(); save()">
        <fieldset class="settings-group" #tiers>
          <legend><h3>Normal and Max</h3></legend>
          <p class="settings-where">
            Saved in this browser only. Your other devices keep their own.
          </p>
          <p class="muted small">
            The Normal | Max switch under the message box and Compare use these, and a new
            conversation starts on a Normal you choose. A suggested model stays on the thread's
            payer when it offers it; a model you choose runs on the payer you chose with it.
            @if (maxSuggested()) {
              {{ maxNote() }}
            }
          </p>
          @for (row of tierRows; track row.tier) {
            <fieldset class="settings-section tier-setting">
              <legend>{{ row.label }}</legend>
              <label class="radio">
                <input
                  type="radio"
                  [name]="id + '-' + row.tier"
                  [attr.aria-describedby]="id + '-' + row.tier + '-suggested'"
                  [checked]="row.suggested()"
                  (change)="setSuggested(row, true)"
                />
                <span>Suggested</span>
              </label>
              <span class="muted small indent" [id]="id + '-' + row.tier + '-suggested'">{{
                suggestion(row.tier)
              }}</span>
              <label class="radio">
                <input
                  type="radio"
                  [name]="id + '-' + row.tier"
                  [checked]="!row.suggested()"
                  (change)="setSuggested(row, false)"
                />
                <span>Choose a model</span>
              </label>
              @if (!row.suggested()) {
                <div class="indent">
                  <app-model-picker
                    [(route)]="row.route"
                    [(modelId)]="row.modelId"
                    [tierPicks]="heldPicks()"
                  />
                </div>
              }
            </fieldset>
          }
        </fieldset>

        <fieldset class="settings-group">
          <legend><h3>How replies are written</h3></legend>
          <fieldset class="settings-section">
            <legend>Default system prompt</legend>
            <p class="settings-where">Synced to your account</p>
            <p class="muted small" [id]="id + '-prompt-help'">
              Used by every conversation without its own prompt (set one in Conversation settings),
              including ones already started.
            </p>
            @if (promptError(); as err) {
              <p class="small" role="alert">Couldn't load it: {{ err }}</p>
            } @else {
              <label class="field">
                <span class="sr-only">Default system prompt</span>
                <textarea
                  rows="10"
                  [attr.maxlength]="maxChars"
                  placeholder="Leave empty to use the built-in prompt"
                  [disabled]="!promptLoaded()"
                  [value]="systemPrompt()"
                  [attr.aria-invalid]="saveError() ? true : null"
                  [attr.aria-describedby]="promptDescribedBy()"
                  (input)="systemPrompt.set(sp.value)"
                  #sp
                ></textarea>
              </label>
              @if (saveError(); as err) {
                <p class="field-error small" role="alert" [id]="saveErrorId" #saveErrorLine>
                  Couldn't save it: {{ err }}
                </p>
              }
              <p class="small settings-status" [id]="id + '-prompt-status'">
                @if (!promptLoaded()) {
                  Loading…
                } @else if (usesBuiltIn()) {
                  Using the built-in prompt: it answers directly, then suggests tangents.
                } @else {
                  Using your prompt.
                }
              </p>
              <div class="settings-buttons">
                <button
                  type="button"
                  class="btn btn-sm"
                  [disabled]="!promptLoaded()"
                  title="Copy the built-in prompt into the box, to edit it"
                  (click)="useDefault()"
                  #startFrom
                >
                  Start from the built-in prompt
                </button>
                @if (systemPrompt() !== '') {
                  <button
                    type="button"
                    class="btn btn-sm"
                    title="Empty the box: conversations without their own prompt use the built-in one"
                    (click)="clearPrompt()"
                  >
                    Clear
                  </button>
                }
              </div>
            }
          </fieldset>
          <app-output-cap-setting
            [(value)]="outputCap"
            [(invalid)]="outputCapInvalid"
            [target]="outputCapTarget()"
          >
            <p class="settings-where">Saved in this browser only.</p>
          </app-output-cap-setting>
        </fieldset>

        <fieldset class="settings-group">
          <legend><h3>What each message sends</h3></legend>
          <p class="settings-where">Saved in this browser only.</p>
          <app-input-limit-setting
            [(value)]="inputLimit"
            [(overflow)]="inputOverflow"
            [(invalid)]="inputLimitInvalid"
            [replyTokens]="outputCap()"
          />
        </fieldset>

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
  private readonly store = inject(TreeStore);
  private readonly tiers = inject(TierStore);
  private readonly ui = inject(UiStore);
  private readonly toast = inject(ToastStore);
  private readonly injector = inject(Injector);
  /** Where it opens: at that section, else at its top. */
  readonly section = input<SettingsSection | null>(null);
  protected readonly id = `sd${++uid}`;
  private readonly tiersSection = viewChild.required<ElementRef<HTMLElement>>('tiers');
  private readonly outputCapSection = viewChild.required<OutputCapSetting, ElementRef<HTMLElement>>(
    OutputCapSetting,
    { read: ElementRef },
  );
  protected readonly openAt = computed(() => {
    switch (this.section()) {
      case 'tiers':
        return this.tiersSection().nativeElement;
      case 'output-cap':
        return this.outputCapSection().nativeElement;
      case null:
        return null;
    }
  });

  protected readonly tierRows: readonly TierRow[] = TIERS.map((tier) => ({
    tier,
    label: TIER_LABELS[tier],
    suggested: signal(true),
    route: signal(''),
    modelId: signal(''),
  }));
  /** Normal and Max as this dialog holds them, which Save stores and the pickers' chips show. */
  protected readonly heldPicks = computed<AppSettings['tiers']>(() => {
    const held = (tier: ModelTier) => {
      const row = this.tierRows.find((r) => r.tier === tier);
      return row ? this.tierChoice(row) : null;
    };
    return { normal: held('normal'), max: held('max') };
  });
  protected readonly maxSuggested = computed(() =>
    this.tierRows.every((row) => row.tier !== 'max' || row.suggested()),
  );
  protected readonly maxNote = computed(() =>
    maxUsageNote(this.tiers.usageFactor(this.store.selectedBranch(), this.heldPicks())),
  );

  /** Reply limit (`AppSettings.maxOutputTokens`); null = Auto. */
  protected readonly outputCap = signal<number | null>(null);
  protected readonly outputCapInvalid = signal(false);
  /** Input limit (`AppSettings.maxInputTokens`, null = off) and what happens over it. */
  protected readonly inputLimit = signal<number | null>(null);
  protected readonly inputOverflow = signal<InputOverflow>('compact');
  protected readonly inputLimitInvalid = signal(false);
  /** The open conversation's model, for the reply limit's hint. */
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
  /** Why the last Save couldn't save the prompt, shown under its box. */
  protected readonly saveError = signal<string | null>(null);
  protected readonly saveErrorId = `${this.id}-save-error`;
  private readonly saveErrorLine = viewChild<ElementRef<HTMLElement>>('saveErrorLine');
  private readonly startFrom = viewChild<ElementRef<HTMLElement>>('startFrom');
  /** The box's helper and status, and why it couldn't be saved. */
  protected readonly promptDescribedBy = computed(() =>
    [`${this.id}-prompt-help`, `${this.id}-prompt-status`]
      .concat(this.saveError() ? [this.saveErrorId] : [])
      .join(' '),
  );
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
    const tiers = this.settings.settings().tiers;
    for (const row of this.tierRows) {
      const own = tiers[row.tier];
      row.suggested.set(own === null);
      if (own) this.pick(row, own);
    }
    void this.loadPrompt();
  }

  /**
   * What Suggested means: the tier the open thread's payer suggests, which
   * differs from thread to thread, or without one open, a new conversation's.
   */
  protected suggestion(tier: ModelTier): string {
    const branch = this.store.selectedBranch();
    const where = branch ? 'In this thread' : 'In a new conversation';
    const c = this.tiers.suggested(tier, branch);
    if (!c) return `Follows each thread's payer. ${where}: no provider suggests one.`;
    const payer = this.store.account.providerOf(c)?.label ?? c.providerId;
    return `Follows each thread's payer. ${where}: ${this.tiers.modelLabel(c)} on ${payer}.`;
  }

  /**
   * Choose a model starts the picker on the tier's model now; back on
   * Suggested, the pick is kept for when it is chosen again.
   */
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

  /** Empties the editor. Clear goes with the text, so the focus moves to its neighbour. */
  protected clearPrompt(): void {
    this.systemPrompt.set('');
    this.startFrom()?.nativeElement.focus();
  }

  protected close(): void {
    this.ui.dialogs.close('settings');
  }

  /**
   * Saves all or nothing: the prompt goes to the account first, and this
   * browser's settings change only once it is saved, so after a failed save
   * Cancel still undoes every edit.
   */
  protected async save(): Promise<void> {
    if (this.outputCapInvalid() || this.inputLimitInvalid()) return;
    const prompt = this.promptToSave();
    if (this.promptLoaded() && prompt !== this.savedPrompt()) {
      this.saving.set(true);
      this.saveError.set(null);
      try {
        const res = await this.api.updateSettings({ systemPrompt: prompt });
        this.savedPrompt.set(res.systemPrompt);
      } catch (err) {
        this.saveError.set(errorMessage(err));
        // Save is at the bottom of a dialog taller than the screen, the error
        // under the prompt above it. The focus stays: moving it to the box
        // would raise a phone's keyboard.
        afterNextRender(
          () => this.saveErrorLine()?.nativeElement.scrollIntoView({ block: 'nearest' }),
          { injector: this.injector },
        );
        return; // keep the dialog (and the edits) open
      } finally {
        this.saving.set(false);
      }
    }
    this.settings.update({
      tiers: this.heldPicks(),
      maxOutputTokens: this.outputCap(),
      maxInputTokens: this.inputLimit(),
      inputOverflow: this.inputOverflow(),
    });
    this.toast.notify('Settings saved');
    this.close();
  }
}
