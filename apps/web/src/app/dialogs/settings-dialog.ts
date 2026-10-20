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
  type SettingsModelChoice,
  TIER_LABELS,
  TIERS,
  type UpdateSettingsRequest,
} from '@tangent/shared';
import {
  type AppSettings,
  type ModelChoice,
  savedChoice,
  SettingsStore,
} from '../state/settings-store';
import { sameChoice, TierStore } from '../state/tier-store';
import { TreeStore } from '../state/tree-store';
import { type SettingsSection, UiStore } from '../state/ui-store';
import { errorMessage, Modal, ToastStore } from '@tangent/web-shared';
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
 * Defaults for every conversation in power, grouped by what they control:
 * Normal and Max; how replies are written (the default system prompt and
 * the reply limit); what each message sends (the input limit). All are kept
 * with the account (`SettingsStore`, `/api/settings`), and Save sends every
 * change in one request, so all or none of them are saved. Opened at a
 * section (`section`), it shows that one and focuses its first choice; else
 * it opens at its top.
 */
@Component({
  selector: 'app-settings-dialog',
  imports: [Modal, ModelPicker, OutputCapSetting, InputLimitSetting],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal
      heading="Settings"
      [focusHeading]="true"
      [openAt]="openAt()"
      [dirty]="dirty"
      (closed)="close()"
    >
      <p class="muted small settings-intro">Defaults for every conversation in power.</p>
      @if (loadError(); as err) {
        <p class="small" role="alert">Couldn't load your settings: {{ err }}</p>
      }
      <form class="form" (submit)="$event.preventDefault(); save()">
        <fieldset class="settings-group" [disabled]="!ready()" #tiers>
          <legend>
            <h3>{{ tierWords.normal }} and {{ tierWords.max }}</h3>
          </legend>
          <p class="settings-where">Synced to your account</p>
          <p class="muted small">
            The {{ tierWords.normal }} | {{ tierWords.max }} switch under the message box and
            Compare use these, and a new conversation starts on a {{ tierWords.normal }} you choose.
            A suggested model stays on the thread's payer when it offers it; a model you choose runs
            on the payer you chose with it.
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

        <fieldset class="settings-group" [disabled]="!ready()">
          <legend><h3>How replies are written</h3></legend>
          <p class="settings-where">Synced to your account</p>
          <fieldset class="settings-section">
            <legend>Default system prompt</legend>
            <p class="muted small" [id]="id + '-prompt-help'">
              Used by every conversation without its own prompt (set one in Conversation settings),
              including ones already started.
            </p>
            <label class="field">
              <span class="sr-only">Default system prompt</span>
              <textarea
                rows="10"
                [attr.maxlength]="maxChars"
                placeholder="Leave empty to use the built-in prompt"
                [value]="systemPrompt()"
                [attr.aria-describedby]="id + '-prompt-help ' + id + '-prompt-status'"
                (input)="systemPrompt.set(sp.value)"
                #sp
              ></textarea>
            </label>
            <p class="small settings-status" [id]="id + '-prompt-status'">
              @if (!ready()) {
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
          </fieldset>
          <app-output-cap-setting
            [(value)]="outputCap"
            [(invalid)]="outputCapInvalid"
            [target]="outputCapTarget()"
          />
        </fieldset>

        <fieldset class="settings-group" [disabled]="!ready()">
          <legend><h3>What each message sends</h3></legend>
          <p class="settings-where">Synced to your account</p>
          <app-input-limit-setting
            [(value)]="inputLimit"
            [(overflow)]="inputOverflow"
            [(invalid)]="inputLimitInvalid"
            [replyTokens]="outputCap()"
          />
        </fieldset>

        @if (saveError(); as err) {
          <p class="field-error small" role="alert" #saveErrorLine>
            Couldn't save your settings: {{ err }}
          </p>
        }
        <div class="form-actions">
          <button type="button" class="btn btn-ghost" (click)="close()">Cancel</button>
          <button
            type="submit"
            class="btn btn-primary"
            [disabled]="!ready() || saving() || outputCapInvalid() || inputLimitInvalid()"
          >
            {{ saving() ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </form>
    </app-modal>
  `,
})
export class SettingsDialog implements OnInit {
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

  /** The tiers' names, for the section's heading and helper (`TIER_LABELS`). */
  protected readonly tierWords = TIER_LABELS;
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
  /**
   * The editors hold the account's settings: until then they stay disabled,
   * so nothing typed is lost to the settings arriving, and Save can't store
   * the defaults over the user's choices.
   */
  protected readonly ready = signal(false);
  protected readonly loadError = signal<string | null>(null);
  /** Why the last Save failed, shown above it. */
  protected readonly saveError = signal<string | null>(null);
  private readonly saveErrorLine = viewChild<ElementRef<HTMLElement>>('saveErrorLine');
  private readonly startFrom = viewChild<ElementRef<HTMLElement>>('startFrom');
  protected readonly saving = signal(false);
  /** What saving the editor would store: blank, or the built-in text unchanged, is the built-in prompt. */
  private readonly promptToSave = computed(() => {
    const text = this.systemPrompt();
    const builtIn = this.settings.prompt().builtIn;
    return text.trim() === '' || text.trim() === builtIn.trim() ? null : text;
  });
  protected readonly usesBuiltIn = computed(() => this.promptToSave() === null);
  /**
   * Edits that closing would lose: a tier or a limit other than the saved
   * one (or typed so that Save can't take it yet), the prompt's box changed.
   */
  protected readonly dirty = computed(() => {
    if (!this.ready()) return false;
    const saved = this.settings.settings();
    return (
      this.editedTiers(saved).length > 0 ||
      this.outputCap() !== saved.maxOutputTokens ||
      this.outputCapInvalid() ||
      this.inputLimit() !== saved.maxInputTokens ||
      this.inputOverflow() !== saved.inputOverflow ||
      this.inputLimitInvalid() ||
      this.systemPrompt() !== (this.settings.prompt().saved ?? '')
    );
  });

  ngOnInit(): void {
    if (this.settings.loaded()) this.fill();
    else void this.load();
  }

  /** Settings opened before they had loaded (or after a failed load): it loads them first. */
  private async load(): Promise<void> {
    try {
      await this.settings.load();
      this.fill();
    } catch (err) {
      this.loadError.set(errorMessage(err));
    }
  }

  /** The editors start on the account's settings. */
  private fill(): void {
    const saved = this.settings.settings();
    this.outputCap.set(saved.maxOutputTokens);
    this.inputLimit.set(saved.maxInputTokens);
    this.inputOverflow.set(saved.inputOverflow);
    for (const row of this.tierRows) {
      const own = saved.tiers[row.tier];
      row.suggested.set(own === null);
      if (own) this.pick(row, own);
    }
    this.systemPrompt.set(this.settings.prompt().saved ?? '');
    this.ready.set(true);
  }

  /** The tiers this dialog holds other than as saved. */
  private editedTiers(saved: AppSettings): ModelTier[] {
    return TIERS.filter((tier) => {
      const held = this.heldPicks()[tier];
      const was = saved.tiers[tier];
      return held && was ? !sameChoice(held, was) : held !== was;
    });
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

  /** Copies the built-in prompt into the editor, to start from it. */
  protected useDefault(): void {
    this.systemPrompt.set(this.settings.prompt().builtIn);
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
   * Saves all or nothing: every change goes to the account in one request,
   * and the settings in use change only once it is saved, so after a failed
   * save the edits are still here and Cancel still undoes every one.
   */
  protected async save(): Promise<void> {
    if (!this.ready() || this.outputCapInvalid() || this.inputLimitInvalid()) return;
    const request = this.changes();
    if (request) {
      this.saving.set(true);
      this.saveError.set(null);
      try {
        await this.settings.save(request);
      } catch (err) {
        this.saveError.set(errorMessage(err));
        // Save is at the bottom of a dialog taller than the screen. The focus
        // stays: moving it would raise a phone's keyboard.
        afterNextRender(
          () => this.saveErrorLine()?.nativeElement.scrollIntoView({ block: 'nearest' }),
          { injector: this.injector },
        );
        return; // keep the dialog (and the edits) open
      } finally {
        this.saving.set(false);
      }
    }
    this.toast.notify('Settings saved');
    this.close();
  }

  /** What differs from the saved settings, as one update; null when nothing does. */
  private changes(): UpdateSettingsRequest | null {
    const saved = this.settings.settings();
    const held = this.heldPicks();
    const tiers: Partial<Record<ModelTier, SettingsModelChoice | null>> = {};
    for (const tier of this.editedTiers(saved)) {
      const pick = held[tier];
      tiers[tier] = pick ? savedChoice(pick) : null;
    }
    const prompt = this.promptToSave();
    const request: UpdateSettingsRequest = {
      ...(Object.keys(tiers).length > 0 ? { tiers } : {}),
      ...(this.outputCap() !== saved.maxOutputTokens ? { maxOutputTokens: this.outputCap() } : {}),
      ...(this.inputLimit() !== saved.maxInputTokens ? { maxInputTokens: this.inputLimit() } : {}),
      ...(this.inputOverflow() !== saved.inputOverflow
        ? { inputOverflow: this.inputOverflow() }
        : {}),
      ...(prompt !== this.settings.prompt().saved ? { systemPrompt: prompt } : {}),
    };
    return Object.keys(request).length > 0 ? request : null;
  }
}
