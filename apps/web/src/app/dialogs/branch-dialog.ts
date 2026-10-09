import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  type OnInit,
  signal,
} from '@angular/core';
import { plainText } from '@tangent/shared';
import {
  isModelAllowed,
  parseRouteKey,
  providerRouteKey,
  routeKey,
  splitTangents,
  type ContextMode,
} from '@tangent/shared';
import { TreeStore } from '../state/tree-store';
import { UiStore, type BranchDialogState } from '../state/ui-store';
import { Modal } from '@tangent/web-shared';
import { ModelPicker } from '../ui/model-picker';
import { ModePicker } from '../ui/mode-picker';

/**
 * "Branch from here": creates a branch off any message and opens it. With a
 * starting message (or one carried from "Ask your own"), sends it as the
 * first message; without, the composer is focused. Titles come after the
 * first reply (auto-titling).
 */
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

        @if (carried(); as text) {
          <div class="excerpt">
            <span class="field-label">First message</span>
            <p>{{ text }}</p>
          </div>
        } @else {
          <label class="field">
            <span class="field-label"
              >Starting message
              <span class="muted">(optional; sent as the branch’s first message)</span></span
            >
            <textarea
              rows="3"
              autofocus
              [value]="message()"
              (input)="message.set(m.value)"
              (keydown)="onMessageKey($event)"
              #m
              placeholder="Ask something to start the branch, or leave empty to write it later"
            ></textarea>
          </label>
        }

        <app-mode-picker [(mode)]="mode" />

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
            {{ saving() ? 'Creating…' : firstMessage() ? 'Create and ask' : 'Create branch' }}
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
    // A reply without its <tangents> block (never shown as text).
    const text = plainText(splitTangents(this.source()?.content ?? '').body);
    return text.length > 280 ? `${text.slice(0, 280)}…` : text;
  });
  private readonly parent = computed(() => {
    const n = this.source();
    return (n && this.store.index()?.branches.get(n.branchId)) || null;
  });

  protected readonly quote = signal('');
  protected readonly mode = signal<ContextMode>('path');
  /** The starting message typed here. */
  protected readonly message = signal('');
  /** A first message written before the dialog opened; replaces the starting message field. */
  protected readonly carried = computed(() => this.state().message?.trim() || null);
  protected readonly firstMessage = computed(() => this.carried() ?? this.message().trim());
  /** Provider and funding, as a `routeKey`. */
  protected readonly route = signal('');
  protected readonly modelId = signal('');
  protected readonly isPrivate = signal(false);
  protected readonly saving = signal(false);

  ngOnInit(): void {
    this.quote.set(this.state().quote ?? '');
    // The parent's route, unless its funding needs the membership the user lacks, or
    // its own key isn't saved in this browser: then the default route of a new
    // conversation (a provider with a key, else Tangent credit where it can pay or be
    // bought), keeping the parent's model where that route serves it.
    const parent = this.parent();
    const usable = parent && !this.store.routeLocked(parent) && !this.store.keyMissing(parent);
    const p = usable ? parent : null;
    const fallback = this.store.defaultProvider();
    this.route.set(p ? routeKey(p) : fallback ? providerRouteKey(fallback) : '');
    const keepModel =
      !p && parent && fallback?.id === parent.providerId && isModelAllowed(fallback, parent.model);
    this.modelId.set(p?.model ?? (keepModel ? parent.model : fallback?.defaultModel) ?? '');
  }

  protected close(): void {
    this.ui.branchDialog.set(null);
  }

  /** Ctrl/Cmd+Enter creates the branch (Enter is a newline, as in the anchor quote). */
  protected onMessageKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
      e.preventDefault();
      void this.create();
    }
  }

  protected async create(): Promise<void> {
    if (this.saving()) return;
    const p = this.parent();
    this.saving.set(true);
    const quote = this.quote().trim();
    const changedModel = !p || routeKey(p) !== this.route() || p.model !== this.modelId().trim();
    const req = {
      fromNodeId: this.state().fromNodeId,
      contextMode: this.mode(),
      anchorQuote: quote || null,
      ...(changedModel && this.route()
        ? { ...parseRouteKey(this.route()), model: this.modelId().trim() }
        : {}),
      isPrivate: this.isPrivate(),
    };
    const first = this.firstMessage();
    const branch = first
      ? await this.store.startBranch(req, first)
      : await this.store.createBranch(req);
    this.saving.set(false);
    if (branch) {
      this.state().onCreated?.();
      this.close();
    }
  }
}
