import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  type OnInit,
  signal,
} from '@angular/core';
import {
  MAX_SYSTEM_PROMPT_CHARS,
  parseRouteKey,
  providerRouteKey,
  routeKey,
} from '@tangent/shared';
import { ReviewStore } from '../state/review-store';
import { SettingsStore } from '../state/settings-store';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { ApiClient, errorMessage, Modal } from '@tangent/web-shared';
import { ModelPicker } from '../ui/model-picker';
import { OutputCapSetting, type OutputCapModel } from '../ui/output-cap-setting';

/**
 * App-wide preferences, one section per feature. The default system prompt
 * is saved to the account (server-side, `/api/settings`); the reviewer and
 * the reply length are saved in this browser.
 */
@Component({
  selector: 'app-settings-dialog',
  imports: [Modal, ModelPicker, OutputCapSetting],
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

        <app-output-cap-setting
          [(value)]="outputCap"
          [(invalid)]="outputCapInvalid"
          [target]="outputCapTarget()"
        />

        <div class="form-actions">
          <button type="button" class="btn btn-ghost" (click)="close()">Cancel</button>
          <button type="submit" class="btn btn-primary" [disabled]="saving() || outputCapInvalid()">
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
  private readonly ui = inject(UiStore);

  protected readonly custom = signal(false);
  /** The reviewer's provider and funding, as a `routeKey`. */
  protected readonly route = signal('');
  protected readonly modelId = signal('');

  /** Reply length (`AppSettings.maxOutputTokens`); null = Auto. */
  protected readonly outputCap = signal<number | null>(null);
  protected readonly outputCapInvalid = signal(false);
  /** The open conversation's model, for the reply-length hint. */
  protected readonly outputCapTarget = computed<OutputCapModel | null>(() => {
    const branch = this.store.selectedBranch();
    return branch ? { model: branch.model, provider: this.store.providerOf(branch) } : null;
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
    const saved = this.settings.settings().reviewer;
    this.custom.set(saved !== null);
    if (saved) {
      this.route.set(routeKey(saved));
      this.modelId.set(saved.model);
    }
    void this.loadPrompt();
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
      const fallback = this.store.defaultProvider();
      this.route.set(start ? routeKey(start) : fallback ? providerRouteKey(fallback) : '');
      this.modelId.set(start?.model ?? fallback?.defaultModel ?? '');
    }
    this.custom.set(true);
  }

  protected close(): void {
    this.ui.settingsOpen.set(false);
  }

  protected async save(): Promise<void> {
    const reviewer =
      this.custom() && this.route() && this.modelId().trim()
        ? { ...parseRouteKey(this.route()), model: this.modelId().trim() }
        : null;
    if (this.outputCapInvalid()) return;
    this.settings.update({ reviewer, maxOutputTokens: this.outputCap() });
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
    this.ui.notify('Settings saved');
    this.close();
  }
}
