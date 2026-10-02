import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  type OnInit,
  signal,
} from '@angular/core';
import { CONTEXT_MODES, type ContextMode } from '@tangent/shared';
import { Icon, Modal } from '@tangent/web-shared';
import { MODE_LABEL } from '../canvas/lane';
import { laneTitle } from '../canvas/titles';
import { CanvasStore } from '../state/canvas-store';
import { UiStore, type BranchSettingsState } from '../state/ui-store';

const MODE_HELP: Record<ContextMode, string> = {
  path: 'Everything the parent lane had at the fork, then this lane.',
  summary: 'A generated summary of the parent context (focused on the quote), then this lane.',
  independent: 'Only the system prompt and the quote: no earlier messages.',
};

/** A lane's title, context mode, anchor quote, model and privacy; and deleting it. */
@Component({
  selector: 'app-branch-settings',
  imports: [Modal, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal heading="Lane settings" (closed)="close()">
      @if (branch(); as b) {
        <form class="form" (submit)="$event.preventDefault(); save()">
          <label class="field">
            <span class="field-label">Title</span>
            <input type="text" maxlength="200" [value]="title()" (input)="title.set(t.value)" #t />
          </label>

          @if (b.parentBranchId) {
            <fieldset class="radio-group">
              <legend class="field-label">Context</legend>
              @for (m of modes; track m) {
                <label class="radio">
                  <input
                    type="radio"
                    name="lane-mode"
                    [value]="m"
                    [checked]="mode() === m"
                    (change)="mode.set(m)"
                  />
                  <span>
                    <strong class="mode-text-{{ m }}">{{ modeLabel[m] }}</strong>
                    <span class="muted small">{{ help[m] }}</span>
                  </span>
                </label>
              }
            </fieldset>

            <label class="field">
              <span class="field-label">Anchor quote</span>
              <textarea rows="2" [value]="quote()" (input)="quote.set(q.value)" #q></textarea>
            </label>
          }

          <div class="field-row">
            <label class="field">
              <span class="field-label">Provider</span>
              <select #ps [value]="providerId()" (change)="pickProvider(ps.value)">
                @if (!store.providerMap().has(providerId())) {
                  <option [value]="providerId()">{{ providerId() }} (not configured)</option>
                }
                @for (p of store.providers(); track p.id) {
                  <option
                    [value]="p.id"
                    [disabled]="!p.available"
                    [selected]="p.id === providerId()"
                  >
                    {{ p.label }}{{ p.available ? '' : ' — no key' }}
                  </option>
                }
              </select>
            </label>
            <label class="field">
              <span class="field-label">Model</span>
              <select #ms [value]="model()" (change)="model.set(ms.value)">
                @if (!modelKnown()) {
                  <option [value]="model()">{{ model() }}</option>
                }
                @for (m of models(); track m.id) {
                  <option [value]="m.id" [selected]="m.id === model()">{{ m.label }}</option>
                }
              </select>
            </label>
          </div>

          @if (b.parentBranchId) {
            <label class="check">
              <input
                type="checkbox"
                [checked]="isPrivate()"
                (change)="isPrivate.set(!isPrivate())"
              />
              Private (left out of shares and exports, with everything below it)
            </label>
          }

          <div class="form-actions">
            @if (b.parentBranchId) {
              <button
                type="button"
                class="btn btn-danger-ghost btn-left"
                [disabled]="saving()"
                (click)="remove()"
              >
                <app-icon name="trash" /> Delete lane
              </button>
            }
            <button type="button" class="btn btn-ghost" (click)="close()">Cancel</button>
            <button type="submit" class="btn btn-primary" [disabled]="saving()">
              {{ saving() ? 'Saving…' : 'Save' }}
            </button>
          </div>
        </form>
      }
    </app-modal>
  `,
})
export class BranchSettings implements OnInit {
  protected readonly store = inject(CanvasStore);
  private readonly ui = inject(UiStore);
  readonly state = input.required<BranchSettingsState>();
  protected readonly modes = CONTEXT_MODES;
  protected readonly modeLabel = MODE_LABEL;
  protected readonly help = MODE_HELP;

  protected readonly branch = computed(
    () => this.store.index()?.branches.get(this.state().branchId) ?? null,
  );
  protected readonly title = signal('');
  protected readonly mode = signal<ContextMode>('path');
  protected readonly quote = signal('');
  protected readonly providerId = signal('');
  protected readonly model = signal('');
  protected readonly isPrivate = signal(false);
  protected readonly saving = signal(false);

  protected readonly models = computed(
    () => this.store.providerMap().get(this.providerId())?.models ?? [],
  );
  protected readonly modelKnown = computed(() => this.models().some((m) => m.id === this.model()));

  ngOnInit(): void {
    const b = this.branch();
    if (!b) return;
    this.title.set(laneTitle(b));
    this.mode.set(b.contextMode);
    this.quote.set(b.anchorQuote ?? '');
    this.providerId.set(b.providerId);
    this.model.set(b.model);
    this.isPrivate.set(b.isPrivate);
  }

  protected pickProvider(id: string): void {
    this.providerId.set(id);
    const p = this.store.providerMap().get(id);
    if (p) this.model.set(p.defaultModel);
  }

  protected close(): void {
    this.ui.branchSettings.set(null);
  }

  protected async save(): Promise<void> {
    const b = this.branch();
    if (!b) return;
    this.saving.set(true);
    const title = this.title().trim();
    const quote = this.quote().trim();
    const ok = await this.store.updateBranch(b.id, {
      ...(title && title !== laneTitle(b) ? { title } : {}),
      ...(b.parentBranchId && this.mode() !== b.contextMode ? { contextMode: this.mode() } : {}),
      ...(b.parentBranchId && quote !== (b.anchorQuote ?? '')
        ? { anchorQuote: quote || null }
        : {}),
      ...(this.providerId() !== b.providerId || this.model() !== b.model
        ? { providerId: this.providerId(), model: this.model() }
        : {}),
      ...(b.parentBranchId && this.isPrivate() !== b.isPrivate
        ? { isPrivate: this.isPrivate() }
        : {}),
    });
    this.saving.set(false);
    if (ok) this.close();
  }

  protected async remove(): Promise<void> {
    const b = this.branch();
    if (!b) return;
    const below = this.store.descendants(b.id).length;
    const what =
      below > 0 ? `“${laneTitle(b)}” and the ${below} lanes below it` : `“${laneTitle(b)}”`;
    if (!confirm(`Delete ${what}? Their messages go too.`)) return;
    this.saving.set(true);
    const ok = await this.store.deleteBranch(b.id);
    this.saving.set(false);
    if (ok) this.close();
  }
}
