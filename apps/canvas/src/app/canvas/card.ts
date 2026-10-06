import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { splitTangents, type ChatNode } from '@tangent/shared';
import { Icon, MarkdownService, TangentAsk } from '@tangent/web-shared';
import { CanvasStore, modelLabel } from '../state/canvas-store';
import { UiStore } from '../state/ui-store';
import { laneTitle } from './titles';

/** How the lineage view reads one message, for the selected lane. */
export type Lit = 'verbatim' | 'summarized' | 'dropped' | 'outside' | 'off';

/** One message on a lane; `data-node-id` lets the page map a text selection to it. */
@Component({
  selector: 'app-card',
  imports: [Icon, TangentAsk],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let n = node();
    <article
      class="card card-{{ n.role }} lit-{{ lit() }}"
      [class.is-focused]="focused()"
      [class.is-error]="n.status === 'error'"
      [class.is-streaming]="streaming()"
      [attr.id]="'card-' + n.id"
      [attr.data-node-id]="n.id"
    >
      <header class="card-head">
        <span class="card-role" [attr.title]="n.model">{{ role() }}</span>
        @switch (lit()) {
          @case ('summarized') {
            <span class="badge mode-summary" title="Reaches the model only through a summary">
              in summary
            </span>
          }
          @case ('dropped') {
            <span class="badge badge-danger" title="Dropped: it did not fit the token budget">
              dropped
            </span>
          }
          @case ('outside') {
            <span class="badge" title="Not sent to the model for the selected lane">
              not sent
            </span>
          }
        }
        <span class="spacer"></span>
        @if (n.status === 'complete') {
          <button
            type="button"
            class="icon-btn card-branch"
            title="Branch from here (one lane, or several variants at once)"
            aria-label="Branch from this message"
            (click)="branch($event)"
          >
            <app-icon name="branch" [size]="15" />
          </button>
        }
      </header>

      @if (streaming() && liveStatus()) {
        <p class="card-status muted small">{{ liveStatus() }}</p>
      }
      <div class="card-body md" [innerHTML]="html()"></div>
      @if (streaming()) {
        <span class="cursor" aria-hidden="true"></span>
        <span class="sr-only">Writing…</span>
      }
      @if (n.status === 'error') {
        <div class="card-error" role="alert">
          <strong>{{ n.error === 'cancelled' ? 'Stopped.' : 'The reply failed.' }}</strong>
          @if (n.error && n.error !== 'cancelled') {
            <span>{{ n.error }}</span>
          }
        </div>
      }

      @if (complete()) {
        <nav class="tangents" aria-label="Tangents worth following">
          <span class="tangents-label muted small">Where next?</span>
          @for (t of tangents(); track t.title) {
            <button
              type="button"
              class="tangent"
              [class.is-followed]="followed().has(t.title)"
              [disabled]="opening() !== null"
              [title]="followed().has(t.title) ? 'Open this lane' : (t.why ?? t.title)"
              (click)="follow(t.title, $event)"
            >
              <app-icon [name]="followed().has(t.title) ? 'chevronRight' : 'branch'" [size]="14" />
              <span class="tangent-title">{{ t.title }}</span>
              @if (t.why) {
                <span class="tangent-why muted">{{ t.why }}</span>
              }
            </button>
          }
          <!-- The user's own question, in a new lane like a tangent. -->
          <app-tangent-ask
            [(text)]="askText"
            label="Ask your own question in a new lane"
            settingsLabel="Lane settings: context, model, variants…"
            [expandable]="true"
            [busy]="asking()"
            [latest]="latest()"
            [disabled]="locked()"
            disabledTitle="Asking needs a membership (this lane is on your own key)"
            (ask)="ask($event)"
            (settings)="askWithSettings($event)"
          />
        </nav>
      }

      @if (children().length > 0) {
        <nav class="card-forks" aria-label="Lanes branching from this message">
          @for (b of children(); track b.id) {
            <button
              type="button"
              class="chip mode-chip-{{ b.contextMode }}"
              [class.is-on]="store.chainIds().has(b.id)"
              [title]="b.anchorQuote ?? laneTitle(b)"
              (click)="open(b.id, $event)"
            >
              {{ laneTitle(b) }}
            </button>
          }
        </nav>
      }
    </article>
  `,
  host: { class: 'card-host' },
})
export class Card {
  protected readonly store = inject(CanvasStore);
  private readonly ui = inject(UiStore);
  private readonly md = inject(MarkdownService);
  protected readonly laneTitle = laneTitle;

  readonly node = input.required<ChatNode>();
  readonly focused = input(false);
  readonly lit = input<Lit>('off');

  /** "You", or the model that wrote the reply (its label when the provider is known). */
  protected readonly role = computed(() => {
    const n = this.node();
    if (n.role === 'user') return 'You';
    if (!n.model) return 'Assistant';
    return modelLabel(this.store.providers(), { providerId: n.providerId ?? '' }, n.model);
  });
  private readonly live = computed(() => this.store.live().get(this.node().id) ?? null);
  protected readonly streaming = computed(() => this.node().status === 'streaming');
  protected readonly liveStatus = computed(() => {
    const l = this.live();
    if (!l) return null;
    return l.reconnecting ? 'Reconnecting…' : l.status;
  });
  protected readonly content = computed(() => this.live()?.content ?? this.node().content);
  private readonly split = computed(() =>
    this.node().role === 'assistant'
      ? splitTangents(this.content())
      : { body: this.content(), tangents: [], partial: false },
  );
  protected readonly html = computed(() => this.md.render(this.split().body, !this.streaming()));
  /** A finished reply: offers its tangents and "Ask your own". */
  protected readonly complete = computed(
    () => this.node().role === 'assistant' && this.node().status === 'complete',
  );
  protected readonly tangents = computed(() => (this.complete() ? this.split().tangents : []));
  /** The card's lane can't generate (its funding needs the membership the user lacks). */
  protected readonly locked = computed(() => {
    const b = this.store.index()?.branches.get(this.node().branchId);
    return !!b && this.store.routeLocked(b);
  });
  protected readonly children = computed(() => this.store.childBranchesAt(this.node().id));
  protected readonly followed = computed<ReadonlySet<string>>(
    () => new Set(this.children().map((b) => b.title)),
  );
  protected readonly opening = signal<string | null>(null);

  /**
   * The selected lane's last card, a finished reply: its "Ask your own"
   * starts open (TangentAsk `latest`). Only the selected lane's, so the canvas
   * never shows a field open in every lane.
   */
  protected readonly latest = computed(() => {
    const n = this.node();
    if (!this.complete() || n.branchId !== this.store.selectedBranchId()) return false;
    return this.store.index()?.nodesByBranch.get(n.branchId)?.at(-1)?.id === n.id;
  });

  /** "Ask your own": the question being typed under the reply. */
  protected readonly askText = signal('');
  protected readonly asking = signal(false);

  protected async ask(text: string): Promise<void> {
    if (this.asking() || this.locked()) return;
    this.asking.set(true);
    try {
      // Kept on failure, to try again.
      if (await this.store.askFrom(this.node().id, text)) this.askText.set('');
    } finally {
      this.asking.set(false);
    }
  }

  /** The gear: the branch dialog (variants and all), asking the question once the lanes exist. */
  protected askWithSettings(text: string): void {
    this.ui.branchDialog.set({
      fromNodeId: this.node().id,
      quote: null,
      ...(text ? { message: text, onCreated: () => this.askText.set('') } : {}),
    });
  }

  protected branch(e: Event): void {
    e.stopPropagation();
    this.ui.branchDialog.set({ fromNodeId: this.node().id, quote: null });
  }

  protected open(branchId: string, e: Event): void {
    e.stopPropagation();
    this.store.go(branchId);
  }

  protected async follow(title: string, e: Event): Promise<void> {
    e.stopPropagation();
    if (this.opening() !== null) return;
    this.opening.set(title);
    try {
      await this.store.followTangent(this.node().id, title);
    } finally {
      this.opening.set(null);
    }
  }
}
