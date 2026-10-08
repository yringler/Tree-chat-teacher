import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  type OnInit,
  signal,
} from '@angular/core';
import {
  CONTEXT_MODES,
  parseRouteKey,
  providerRouteKey,
  routeKey,
  type ContextMode,
} from '@tangent/shared';
import { Icon, Modal } from '@tangent/web-shared';
import { MODE_LABEL } from '../canvas/lane';
import { confirmDeleteLane } from '../canvas/delete-lane';
import { laneTitle } from '../canvas/titles';
import { CanvasStore } from '../state/canvas-store';
import { UiStore, type BranchSettingsState } from '../state/ui-store';
import { ModelField, routeSuffix } from './model-field';

const MODE_HELP: Record<ContextMode, string> = {
  path: 'Everything the parent lane had at the fork, then this lane.',
  summary: 'A generated summary of the parent context (focused on the quote), then this lane.',
  message: 'Only the message this lane forks from and the quote: no other earlier messages.',
  independent: 'Only the system prompt and the quote: no earlier messages.',
};

/** A lane's title, context mode, anchor quote, model and privacy; and deleting it. */
@Component({
  selector: 'app-branch-settings',
  imports: [Modal, Icon, ModelField],
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
              <select #ps [value]="route()" (change)="pickProvider(ps.value)">
                @if (!store.providerMap().has(route())) {
                  <option [value]="route()">{{ route() }} (not configured)</option>
                }
                @for (p of store.providers(); track key(p)) {
                  <option
                    [value]="key(p)"
                    [disabled]="!p.available || store.routeLocked(p)"
                    [selected]="key(p) === route()"
                  >
                    {{ p.label }}{{ suffix(p, store.routeLocked(p)) }}
                  </option>
                }
              </select>
            </label>
            <app-model-field
              [provider]="store.providerMap().get(route()) ?? null"
              [(model)]="model"
            />
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
  protected readonly key = providerRouteKey;
  protected readonly suffix = routeSuffix;
  /** Provider and funding, as a `routeKey`. */
  protected readonly route = signal('');
  protected readonly model = signal('');
  protected readonly isPrivate = signal(false);
  protected readonly saving = signal(false);

  ngOnInit(): void {
    const b = this.branch();
    if (!b) return;
    this.title.set(laneTitle(b));
    this.mode.set(b.contextMode);
    this.quote.set(b.anchorQuote ?? '');
    this.route.set(routeKey(b));
    this.model.set(b.model);
    this.isPrivate.set(b.isPrivate);
  }

  protected pickProvider(route: string): void {
    this.route.set(route);
    const p = this.store.providerMap().get(route);
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
      ...(this.route() !== routeKey(b) || this.model().trim() !== b.model
        ? { ...parseRouteKey(this.route()), model: this.model().trim() }
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
    this.saving.set(true);
    const ok = await confirmDeleteLane(this.store, b.id);
    this.saving.set(false);
    if (ok) this.close();
  }
}
