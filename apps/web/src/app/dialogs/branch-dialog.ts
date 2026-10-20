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
} from '@angular/core';
import {
  DEFAULT_GROUNDING_MODE,
  parseRouteKey,
  plainText,
  routeKey,
  splitTangents,
  type ContextMode,
  type GroundingMode,
} from '@tangent/shared';
import { TierStore } from '../state/tier-store';
import { TreeStore } from '../state/tree-store';
import { UiStore, type BranchDialogState } from '../state/ui-store';
import { ComposerController, Modal, startingRoute } from '@tangent/web-shared';
import { ModePicker } from '../ui/mode-picker';
import { ReplyFields, routeSearches, searchSummary } from '../ui/reply-fields';

let uid = 0;

/**
 * "Tangent from here": a tangent off any message, made with its first
 * message (typed here, starting from what the message box held when its
 * Tangent ↳ caret opened it), which it sends and opens. Cancelling makes
 * nothing, and leaves the box as it was. Titles come after the first reply
 * (auto-titling). Its groups are Tangent settings': Context (the quote, read
 * only, and the mode), Replies, Private. Replies fold into one line naming
 * who pays, the model and web search, until Change opens their fields.
 */
@Component({
  selector: 'app-branch-dialog',
  imports: [Modal, ModePicker, ReplyFields],
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

        <app-mode-picker [(mode)]="mode">
          @if (quote()) {
            <div class="excerpt quote-excerpt" role="group" [attr.aria-labelledby]="id + '-q'">
              <div class="excerpt-head">
                <span class="field-label" [id]="id + '-q'">Quote</span>
                <button
                  type="button"
                  class="btn btn-sm"
                  aria-label="Remove quote"
                  (click)="removeQuote()"
                >
                  Remove
                </button>
              </div>
              <p>{{ quote() }}</p>
            </div>
          }
        </app-mode-picker>

        @if (route()) {
          <fieldset class="settings-section" #replies>
            <legend>Replies</legend>
            @if (changing()) {
              <app-reply-fields [(route)]="route" [(modelId)]="modelId" [(grounding)]="grounding" />
            } @else {
              @let r = summary();
              <p class="reply-summary">
                <span [id]="id + '-r'"
                  >{{ same() ? 'Same as the bar under the message box: ' : ''
                  }}<strong>{{ r.payer }}</strong> · {{ r.model }} · {{ r.search }}.</span
                >
                <button
                  type="button"
                  class="btn btn-sm"
                  aria-expanded="false"
                  [attr.aria-describedby]="id + '-r'"
                  (click)="change()"
                >
                  Change
                </button>
              </p>
            }
          </fieldset>
        }

        <div class="field">
          <label class="check">
            <input
              type="checkbox"
              [attr.aria-describedby]="id + '-private'"
              [checked]="isPrivate()"
              (change)="isPrivate.set(!isPrivate())"
            />
            Private
          </label>
          <span class="muted small indent" [id]="id + '-private'"
            >Left out of shares and exports, with every tangent under it.</span
          >
        </div>

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
  private readonly tiers = inject(TierStore);
  private readonly composer = inject(ComposerController);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly replies = viewChild<ElementRef<HTMLElement>>('replies');
  readonly state = input.required<BranchDialogState>();
  protected readonly id = `bd${++uid}`;

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
  protected readonly grounding = signal<GroundingMode>(DEFAULT_GROUNDING_MODE);
  protected readonly isPrivate = signal(false);
  protected readonly saving = signal(false);
  /** Replies' fields are open (Change), not folded into their line. */
  protected readonly changing = signal(false);

  /**
   * The replies are the open thread's (the route the bar under the message
   * box shows, and its web search): the line says so. A read-only thread
   * shows no bar.
   */
  protected readonly same = computed(() => {
    const bar = this.store.readOnly() ? null : this.store.selectedBranch();
    return (
      !!bar &&
      routeKey(bar) === this.route() &&
      bar.model === this.modelId().trim() &&
      (bar.grounding ?? DEFAULT_GROUNDING_MODE) === this.grounding()
    );
  });

  /** The folded line: who pays, the model (by tier, as the bar names it), web search. */
  protected readonly summary = computed(() => {
    const route = parseRouteKey(this.route());
    return {
      payer: this.store.account.providerOf(route)?.label ?? route.providerId,
      model: this.tiers.tierOrModel({ ...route, model: this.modelId().trim() }),
      search: searchSummary(this.grounding(), routeSearches(this.store, this.route())),
    };
  });

  ngOnInit(): void {
    this.quote.set(this.state().quote ?? '');
    this.message.set(this.state().message ?? '');
    // The route tangents start on (the open thread's, `TreeStore.tangentRoute`), unless it
    // can't generate here: then the default route of a new conversation (a provider with a
    // key, else Tangent credit where it can pay or be bought), keeping its model where that
    // route serves it. Web search as in the message's thread, as for a tangent from the box.
    const base = this.store.tangentRoute(this.parent());
    const usable = !!base && this.store.account.routeState(base) === 'open';
    const start =
      this.state().route ?? startingRoute(base, usable, this.store.account.defaultProvider());
    this.route.set(start.providerId ? routeKey(start) : '');
    this.modelId.set(start.model);
    this.grounding.set(this.parent()?.grounding ?? DEFAULT_GROUNDING_MODE);
  }

  protected close(): void {
    this.ui.dialogs.close('branch');
  }

  /** Change: the replies' fields open, the focus on the first (who pays). */
  protected change(): void {
    this.changing.set(true);
    afterNextRender(() => this.replies()?.nativeElement.querySelector('select')?.focus(), {
      injector: this.injector,
    });
  }

  /** The quote goes; the focus, which was on its button, moves to the mode chosen. */
  protected removeQuote(): void {
    this.quote.set('');
    afterNextRender(
      () =>
        this.host.nativeElement
          .querySelector<HTMLElement>('.context-group input[type=radio]:checked')
          ?.focus(),
      { injector: this.injector },
    );
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
      ...(this.route()
        ? {
            ...parseRouteKey(this.route()),
            model: this.modelId().trim(),
            grounding: this.grounding(),
          }
        : {}),
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
