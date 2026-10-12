import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import {
  groupTangents,
  KEEP_GOING_LABEL,
  REPLY_ACTION,
  TANGENTS_LABEL,
  type Branch,
  type ChatNode,
  type Tangent,
} from '@tangent/shared';
import { Icon, TangentAsk } from '@tangent/web-shared';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';

let uid = 0;

/**
 * The suggestions under a finished reply, in two groups. "Keep going": next
 * steps in the thread's topic, each sent as the next message here, so only
 * the latest reply of the thread on screen offers them. "Tangents": side
 * trips, each a tangent to start (or the one already following it), then
 * "Ask your own".
 */
@Component({
  selector: 'app-tangent-nav',
  imports: [Icon, TangentAsk],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
  template: `
    @if (keepGoing().length > 0 || sideTrips().length > 0 || canAsk()) {
      <div class="tangents">
        @if (keepGoing().length > 0) {
          <nav class="tangents-group" [attr.aria-labelledby]="ids.next">
            <span class="tangents-group-label muted small" [id]="ids.next">{{ labels.next }}</span>
            @for (t of keepGoing(); track t.title) {
              <button
                type="button"
                class="tangent"
                [disabled]="continuing() || locked()"
                [title]="
                  locked()
                    ? 'Continuing needs a membership (this thread is on your own key)'
                    : nextHint()
                "
                (click)="continueWith($event, t.title)"
              >
                <app-icon name="next" [size]="14" />
                <span class="tangent-title">{{ t.title }}</span>
                @if (t.why) {
                  <span class="tangent-why muted">{{ t.why }}</span>
                }
              </button>
            }
          </nav>
        }
        @if (sideTrips().length > 0 || canAsk()) {
          <nav class="tangents-group" [attr.aria-labelledby]="ids.side">
            <span class="tangents-group-label muted small" [id]="ids.side">{{ labels.side }}</span>
            @for (t of sideTrips(); track t.title) {
              <button
                type="button"
                class="tangent"
                [class.is-followed]="followed().has(t.title)"
                [class.is-on]="followedOn().has(t.title)"
                [disabled]="opening() !== null || (locked() && !followed().has(t.title))"
                [title]="
                  followed().has(t.title)
                    ? 'Open tangent'
                    : locked()
                      ? 'Starting a tangent needs a membership (this thread is on your own key)'
                      : 'Go on a tangent about this (keeps the conversation so far)'
                "
                (click)="follow($event, t.title)"
              >
                <app-icon
                  [name]="followed().has(t.title) ? 'chevronRight' : 'tangent'"
                  [size]="14"
                />
                <span class="tangent-title">{{ t.title }}</span>
                @if (t.why) {
                  <span class="tangent-why muted">{{ t.why }}</span>
                }
              </button>
            }
            @if (canAsk()) {
              <!-- The user's own question, started as a tangent like a suggested one. -->
              <app-tangent-ask
                [(text)]="askText"
                label="Ask your own question in a new tangent"
                settingsLabel="Tangent settings: context, model, quote…"
                [expandable]="true"
                [reveal]="true"
                [busy]="asking()"
                [latest]="store.isLatest(node().id)"
                [disabled]="locked()"
                disabledTitle="Asking needs a membership (this thread is on your own key)"
                (ask)="ask($event)"
                (settings)="askWithSettings($event)"
                (click)="$event.stopPropagation()"
              />
            }
          </nav>
        }
      </div>
    }
  `,
})
export class TangentNav {
  protected readonly store = inject(TreeStore);
  private readonly ui = inject(UiStore);

  /** A finished reply. */
  readonly node = input.required<ChatNode>();
  readonly tangents = input.required<readonly Tangent[]>();
  /** The branches started from the reply. */
  readonly children = input.required<readonly Branch[]>();
  /** The selected branch's chain (a followed tangent on it is lit). */
  readonly chainIds = input<ReadonlySet<string>>(new Set());

  protected readonly labels = { next: KEEP_GOING_LABEL, side: TANGENTS_LABEL };
  protected readonly ids = { next: `keep-going-${++uid}`, side: `tangents-${uid}` };
  private readonly groups = computed(() => groupTangents(this.tangents()));
  /** Next steps: only where sending one continues the thread on screen. */
  protected readonly keepGoing = computed(() =>
    this.store.isLatest(this.node().id) ? this.groups().continue : [],
  );
  protected readonly sideTrips = computed(() => this.groups().tangent);
  /** Inside a tangent, the next step continues that tangent rather than the main thread. */
  protected readonly nextHint = computed(() =>
    this.store.branchOf(this.node().id)?.parentBranchId
      ? REPLY_ACTION.hintInTangent
      : REPLY_ACTION.hint,
  );
  /** The reply's branch can't generate (its funding needs the membership the user lacks). */
  protected readonly locked = computed(() => this.store.nodeLocked(this.node().id));
  /** Titles of the tangents already followed (a child branch carries the title). */
  protected readonly followed = computed<ReadonlySet<string>>(() => {
    const titles = new Set(this.sideTrips().map((t) => t.title));
    return new Set(
      this.children()
        .map((b) => b.title)
        .filter((t) => titles.has(t)),
    );
  });
  /** Followed tangents on the selected branch's chain. */
  protected readonly followedOn = computed<ReadonlySet<string>>(() => {
    const on = this.chainIds();
    return new Set(
      this.children()
        .filter((b) => on.has(b.id))
        .map((b) => b.title),
    );
  });
  /** "Ask your own": offered wherever suggestions are, while a branch can be generated on. */
  protected readonly canAsk = computed(() => this.store.account.canGenerate());
  /** Title of the tangent whose branch is being created. */
  protected readonly opening = signal<string | null>(null);
  /** A next step is being sent. */
  protected readonly continuing = signal(false);
  protected readonly askText = signal('');
  protected readonly asking = signal(false);

  protected async continueWith(e: Event, title: string): Promise<void> {
    e.stopPropagation();
    if (this.continuing() || this.locked()) return;
    this.continuing.set(true);
    try {
      await this.store.continueWith(this.node().id, title);
    } finally {
      this.continuing.set(false);
    }
  }

  protected async follow(e: Event, title: string): Promise<void> {
    e.stopPropagation();
    if (this.opening() !== null || (this.locked() && !this.followed().has(title))) return;
    this.opening.set(title);
    try {
      await this.store.followTangent(this.node().id, title);
    } finally {
      this.opening.set(null);
    }
  }

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

  /** The gear: the tangent dialog, sending the question once the branch is set up. */
  protected askWithSettings(text: string): void {
    this.ui.dialogs.open({
      kind: 'branch',
      fromNodeId: this.node().id,
      quote: null,
      ...(text ? { message: text, onCreated: () => this.askText.set('') } : {}),
    });
  }
}
