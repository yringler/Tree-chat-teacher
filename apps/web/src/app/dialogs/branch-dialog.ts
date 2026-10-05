import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  type OnInit,
  signal,
} from '@angular/core';
import { plainText } from '@tangent/core';
import { parseRouteKey, providerRouteKey, routeKey, type ContextMode } from '@tangent/shared';
import { TreeStore } from '../state/tree-store';
import { UiStore, type BranchDialogState } from '../state/ui-store';
import { Modal } from '@tangent/web-shared';
import { ModelPicker } from '../ui/model-picker';
import { ModePicker } from '../ui/mode-picker';

/** "Branch from here": creates a branch off any message, then opens it with the composer focused. */
@Component({
  selector: 'app-branch-dialog',
  imports: [Modal, ModePicker, ModelPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal heading="Branch from here" (closed)="close()">
      <form class="form" (submit)="$event.preventDefault(); create()">
        @if (source(); as n) {
          <div class="excerpt">
            <span class="field-label">{{ n.role === 'user' ? 'Your message' : 'Assistant' }}</span>
            <p>{{ excerpt() }}</p>
          </div>
        }

        <label class="field">
          <span class="field-label"
            >Anchor quote <span class="muted">(optional; focuses the new branch)</span></span
          >
          <textarea
            rows="3"
            [value]="quote()"
            (input)="quote.set(q.value)"
            #q
            placeholder="Select text in a message before branching to quote it"
          ></textarea>
        </label>
        @if (quote()) {
          <button type="button" class="link-btn small" (click)="quote.set('')">Remove quote</button>
        }

        <app-mode-picker [(mode)]="mode" />

        <label class="field">
          <span class="field-label"
            >Title <span class="muted">(optional; generated after the first reply)</span></span
          >
          <input type="text" maxlength="200" [value]="title()" (input)="title.set(t.value)" #t />
        </label>

        @if (route()) {
          <app-model-picker [(route)]="route" [(modelId)]="modelId" />
        }

        <label class="check">
          <input type="checkbox" [checked]="isPrivate()" (change)="isPrivate.set(!isPrivate())" />
          Private (excluded from shares and exports, with everything below it)
        </label>

        <div class="form-actions">
          <button type="button" class="btn btn-ghost" (click)="close()">Cancel</button>
          <button type="submit" class="btn btn-primary" [disabled]="saving()">
            {{ saving() ? 'Creating…' : 'Create branch' }}
          </button>
        </div>
      </form>
    </app-modal>
  `,
})
export class BranchDialog implements OnInit {
  private readonly store = inject(TreeStore);
  private readonly ui = inject(UiStore);
  readonly state = input.required<BranchDialogState>();

  protected readonly source = computed(
    () => this.store.index()?.nodes.get(this.state().fromNodeId) ?? null,
  );
  protected readonly excerpt = computed(() => {
    const text = plainText(this.source()?.content ?? '');
    return text.length > 280 ? `${text.slice(0, 280)}…` : text;
  });
  private readonly parent = computed(() => {
    const n = this.source();
    return (n && this.store.index()?.branches.get(n.branchId)) || null;
  });

  protected readonly quote = signal('');
  protected readonly mode = signal<ContextMode>('path');
  protected readonly title = signal('');
  /** Provider and funding, as a `routeKey`. */
  protected readonly route = signal('');
  protected readonly modelId = signal('');
  protected readonly isPrivate = signal(false);
  protected readonly saving = signal(false);

  ngOnInit(): void {
    this.quote.set(this.state().quote ?? '');
    const p = this.parent();
    const fallback = this.store.defaultProvider();
    this.route.set(p ? routeKey(p) : fallback ? providerRouteKey(fallback) : '');
    this.modelId.set(p?.model ?? fallback?.defaultModel ?? '');
  }

  protected close(): void {
    this.ui.branchDialog.set(null);
  }

  protected async create(): Promise<void> {
    const p = this.parent();
    this.saving.set(true);
    const quote = this.quote().trim();
    const title = this.title().trim();
    const changedModel = !p || routeKey(p) !== this.route() || p.model !== this.modelId().trim();
    const branch = await this.store.createBranch({
      fromNodeId: this.state().fromNodeId,
      contextMode: this.mode(),
      anchorQuote: quote || null,
      ...(title ? { title } : {}),
      ...(changedModel && this.route()
        ? { ...parseRouteKey(this.route()), model: this.modelId().trim() }
        : {}),
      isPrivate: this.isPrivate(),
    });
    this.saving.set(false);
    if (branch) this.close();
  }
}
