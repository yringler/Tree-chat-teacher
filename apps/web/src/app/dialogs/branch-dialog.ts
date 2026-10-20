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
  parseRouteKey,
  plainText,
  routeKey,
  splitTangents,
  type ContextMode,
} from '@tangent/shared';
import { TreeStore } from '../state/tree-store';
import { UiStore, type BranchDialogState } from '../state/ui-store';
import { ComposerController, Modal, startingRoute } from '@tangent/web-shared';
import { ModelPicker } from '../ui/model-picker';
import { ModePicker } from '../ui/mode-picker';

/**
 * "Tangent from here": a tangent off any message, made with its first
 * message (typed here, starting from what the message box held when its
 * Tangent ↳ caret opened it), which it sends and opens. Cancelling makes
 * nothing, and leaves the box as it was. Titles come after the first reply
 * (auto-titling).
 */
@Component({
  selector: 'app-branch-dialog',
  imports: [Modal, ModePicker, ModelPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal heading="Tangent from here" (closed)="close()">
      <form class="form" (submit)="$event.preventDefault(); create()" (keydown)="onKey($event)">
        @if (source(); as n) {
          <div class="excerpt">
            <span class="field-label">{{ n.role === 'user' ? 'Your message' : 'Assistant' }}</span>
            <p>{{ excerpt() }}</p>
          </div>
        }

        <label class="field">
          <span class="field-label"
            >Anchor quote <span class="muted">(optional; focuses the new tangent)</span></span
          >
          <textarea
            rows="3"
            [value]="quote()"
            (input)="quote.set(q.value)"
            #q
            placeholder="Select text in a message before starting the tangent to quote it"
          ></textarea>
        </label>
        @if (quote()) {
          <button type="button" class="link-btn small" (click)="quote.set('')">Remove quote</button>
        }

        <label class="field">
          <span class="field-label"
            >Starting message <span class="muted">(the tangent’s first message)</span></span
          >
          <textarea
            rows="3"
            autofocus
            required
            [value]="message()"
            (input)="message.set(m.value)"
            #m
            placeholder="Ask something to start the tangent"
          ></textarea>
        </label>

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
          <button type="submit" class="btn btn-primary" [disabled]="saving() || !message().trim()">
            {{ saving() ? 'Creating…' : 'Create and ask' }}
          </button>
        </div>
      </form>
    </app-modal>
  `,
})
export class BranchDialog implements OnInit {
  private readonly store = inject(TreeStore);
  private readonly ui = inject(UiStore);
  private readonly composer = inject(ComposerController);
  readonly state = input.required<BranchDialogState>();

  protected readonly source = computed(
    () => this.store.index()?.nodes.get(this.state().fromNodeId) ?? null,
  );
  // A reply without its <tangents> block (never shown as text).
  protected readonly excerpt = computed(() =>
    plainText(splitTangents(this.source()?.content ?? '').body, { max: 280 }),
  );
  private readonly parent = computed(() => {
    const n = this.source();
    return (n && this.store.index()?.branches.get(n.branchId)) || null;
  });

  protected readonly quote = signal('');
  protected readonly mode = signal<ContextMode>('path');
  /** The starting message. */
  protected readonly message = signal('');
  /** Provider and funding, as a `routeKey`. */
  protected readonly route = signal('');
  protected readonly modelId = signal('');
  protected readonly isPrivate = signal(false);
  protected readonly saving = signal(false);

  ngOnInit(): void {
    this.quote.set(this.state().quote ?? '');
    this.message.set(this.state().message ?? '');
    // The route tangents start on (the open thread's, `TreeStore.tangentRoute`), unless it
    // can't generate here: then the default route of a new conversation (a provider with a
    // key, else Tangent credit where it can pay or be bought), keeping its model where that
    // route serves it.
    const base = this.store.tangentRoute(this.parent());
    const usable = !!base && this.store.account.routeState(base) === 'open';
    const start =
      this.state().route ?? startingRoute(base, usable, this.store.account.defaultProvider());
    this.route.set(start.providerId ? routeKey(start) : '');
    this.modelId.set(start.model);
  }

  protected close(): void {
    this.ui.dialogs.close('branch');
  }

  /** Ctrl/Cmd+Enter in any field creates and asks (Enter is a newline in the text fields). */
  protected onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
      e.preventDefault();
      void this.create();
    }
  }

  protected async create(): Promise<void> {
    const first = this.message().trim();
    if (this.saving() || !first) return;
    this.saving.set(true);
    const quote = this.quote().trim();
    const req = {
      fromNodeId: this.state().fromNodeId,
      contextMode: this.mode(),
      anchorQuote: quote || null,
      ...(this.route() ? { ...parseRouteKey(this.route()), model: this.modelId().trim() } : {}),
      isPrivate: this.isPrivate(),
    };
    const branch = await this.store.startBranch(req, first);
    this.saving.set(false);
    if (!branch) return;
    // The box's text went into this tangent, edited here or not: the box,
    // still holding it, lets it go, as for a message it sent itself. A first
    // message the server then refuses comes back to the box (`unsentDrafts`).
    const carried = this.state().message;
    if (carried) this.composer.sent(branch.id, carried);
    this.close();
  }
}
