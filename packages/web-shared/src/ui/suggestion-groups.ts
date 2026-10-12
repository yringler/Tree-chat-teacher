import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import {
  groupTangents,
  KEEP_GOING_LABEL,
  REPLY_ACTION,
  TANGENTS_LABEL,
  type Branch,
  type Tangent,
} from '@tangent/shared';
import { Icon } from './icon';

let uid = 0;

/**
 * The suggestions under a finished reply, in two groups (every app).
 * "Keep going": next steps in the thread's topic, each sent as the next
 * message here (`send`), so only the newest reply of the thread on screen
 * (`latest`) offers them. "Tangents": side trips, each a tangent to start or
 * the one already following it (`open`). Projected content (power and
 * Canvas: "Ask your own") ends the Tangents group when `withAsk` is set.
 *
 * It keeps a step from being sent twice and one tangent opening at a time;
 * the app does the sending and opening. `locked`: the reply's thread can't
 * generate (its funding needs the membership the user lacks), so only a
 * tangent already followed still opens; `noun` names that thread.
 */
@Component({
  selector: 'app-suggestion-groups',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
  template: `
    @if (keepGoing().length > 0 || sideTrips().length > 0 || withAsk()) {
      <div class="tangents">
        @if (keepGoing().length > 0) {
          <nav class="tangents-group" [attr.aria-labelledby]="ids.next">
            <span class="tangents-group-label muted small" [id]="ids.next">{{ labels.next }}</span>
            @for (t of keepGoing(); track t.title) {
              <button
                type="button"
                class="tangent tangent-continue"
                [disabled]="busy() || continuing() || opening() !== null || locked()"
                [title]="
                  locked()
                    ? 'Continuing needs a membership (this ' + noun() + ' is on your own key)'
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
        @if (sideTrips().length > 0 || withAsk()) {
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
                      ? 'Starting a tangent needs a membership (this ' +
                        noun() +
                        ' is on your own key)'
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
            <ng-content />
          </nav>
        }
      </div>
    }
  `,
})
export class SuggestionGroups {
  /** The finished reply's suggestions. */
  readonly tangents = input.required<readonly Tangent[]>();
  /** The newest reply of the thread on screen: the only one offering next steps. */
  readonly latest = input(false);
  /** The reply is in a tangent, so a next step continues it rather than the main thread. */
  readonly inTangent = input(false);
  /** The branches started from the reply (one titled after a suggestion follows it). */
  readonly children = input<readonly Branch[]>([]);
  /** The selected branch's chain: a followed tangent on it is lit. */
  readonly chainIds = input<ReadonlySet<string>>(new Set());
  readonly locked = input(false);
  readonly noun = input<'thread' | 'lane'>('thread');
  /** Something else is generating, so a next step waits. */
  readonly busy = input(false);
  /** "Ask your own" is projected: the Tangents group shows even with no suggestion. */
  readonly withAsk = input(false);
  /** Sends a next step as the next message after the reply. */
  readonly send = input.required<(title: string) => Promise<unknown>>();
  /** Opens the tangent following a suggestion, starting it first if needed. */
  readonly open = input.required<(title: string) => Promise<unknown>>();

  protected readonly labels = { next: KEEP_GOING_LABEL, side: TANGENTS_LABEL };
  protected readonly ids = { next: `keep-going-${++uid}`, side: `tangents-${uid}` };
  private readonly groups = computed(() => groupTangents(this.tangents()));
  protected readonly keepGoing = computed(() => (this.latest() ? this.groups().continue : []));
  protected readonly sideTrips = computed(() => this.groups().tangent);
  protected readonly nextHint = computed(() =>
    this.inTangent() ? REPLY_ACTION.hintInTangent : REPLY_ACTION.hint,
  );
  /** Titles of the suggestions already followed. */
  protected readonly followed = computed<ReadonlySet<string>>(() => {
    const titles = new Set(this.sideTrips().map((t) => t.title));
    return new Set(
      this.children()
        .map((b) => b.title)
        .filter((t) => titles.has(t)),
    );
  });
  /** Followed suggestions on the selected branch's chain. */
  protected readonly followedOn = computed<ReadonlySet<string>>(() => {
    const on = this.chainIds();
    return new Set(
      this.children()
        .filter((b) => on.has(b.id))
        .map((b) => b.title),
    );
  });
  /** A next step is being sent. */
  protected readonly continuing = signal(false);
  /** Title of the suggestion whose tangent is opening. */
  protected readonly opening = signal<string | null>(null);

  protected async continueWith(e: Event, title: string): Promise<void> {
    e.stopPropagation();
    if (this.busy() || this.continuing() || this.opening() !== null || this.locked()) return;
    this.continuing.set(true);
    try {
      await this.send()(title);
    } finally {
      this.continuing.set(false);
    }
  }

  protected async follow(e: Event, title: string): Promise<void> {
    e.stopPropagation();
    if (this.opening() !== null || (this.locked() && !this.followed().has(title))) return;
    this.opening.set(title);
    try {
      await this.open()(title);
    } finally {
      this.opening.set(null);
    }
  }
}
