import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  signal,
  type TemplateRef,
} from '@angular/core';
import {
  DIG_DEEPER_LABEL,
  SUGGESTED_TANGENTS_LABEL,
  suggestedFoldLabel,
  tangentFooter,
  YOUR_TANGENTS_LABEL,
  type Branch,
  type Tangent,
} from '@tangent/shared';
import { Icon } from './icon';

let uid = 0;

/**
 * The footer under a message (every app), sorted by where the user went
 * (`tangentFooter`). "Your tangents": every tangent started from the
 * message (`children`), first and never folded, because this is the only
 * place a message says the user left from here; each opens (`openBranch`),
 * is lit while on the open thread's chain (`chainIds`) or just come back
 * from (`cameFromIds`), and, where the app deletes from here, has a trash
 * button (`remove`).
 * Then the suggestions no tangent follows yet, each a tangent to start
 * (`open`): "Dig deeper" (further into the reply's topic), then "Suggested
 * tangents" (further out). Once the message has a tangent of the user's,
 * both fold behind one button, so the footer changes only when a tangent is
 * started or deleted. Projected content (Canvas: "Ask your own") ends the
 * suggestions when `withAsk` is set, and never folds.
 *
 * It keeps one suggestion opening at a time; the app does the opening. `locked`: the message's
 * thread can't generate (its funding needs the membership the user lacks),
 * so its suggestions fold and only the user's tangents open; `noun` names
 * that thread. `compact` shows the user's tangents as chips, each carrying
 * its context mode (`mode-chip-<mode>`) for the app to colour, and
 * `rowExtra` adds the app's details to the end of each row.
 */
@Component({
  selector: 'app-suggestion-groups',
  imports: [Icon, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
  template: `
    @let f = footer();
    @if (f.yours.length > 0 || openCount() > 0 || withAsk()) {
      <div class="tangents">
        @if (f.yours.length > 0) {
          <div
            class="tangents-group tangents-yours"
            role="group"
            [attr.aria-labelledby]="ids.yours"
          >
            <span class="tangents-group-label muted small" [id]="ids.yours">{{
              labels.yours
            }}</span>
            @if (compact()) {
              <div class="tangent-chips">
                @for (b of f.yours; track b.id) {
                  <button
                    type="button"
                    class="tangent-chip mode-chip-{{ b.contextMode }}"
                    [class.is-on]="chainIds().has(b.id)"
                    [class.is-back]="cameFromIds().has(b.id)"
                    [attr.aria-current]="chainIds().has(b.id) ? 'true' : null"
                    [attr.title]="tipOf(b)"
                    (click)="openYours($event, b)"
                  >
                    <span class="sr-only">{{ labels.open }}</span
                    ><span [attr.title]="fullTitleOf(b)">{{ titleOf()(b) }}</span>
                    @if (cameFromIds().has(b.id)) {
                      <span class="sr-only">{{ labels.back }}</span>
                    }
                  </button>
                }
              </div>
            } @else {
              @for (b of f.yours; track b.id) {
                <div
                  class="tangent tangent-yours"
                  [class.is-on]="chainIds().has(b.id)"
                  [class.is-back]="cameFromIds().has(b.id)"
                >
                  <button
                    type="button"
                    class="tangent-yours-open"
                    [attr.aria-current]="chainIds().has(b.id) ? 'true' : null"
                    [attr.title]="tipOf(b)"
                    (click)="openYours($event, b)"
                  >
                    <app-icon name="chevronRight" [size]="14" />
                    <span class="sr-only">{{ labels.open }}</span>
                    <span class="tangent-title" [attr.title]="fullTitleOf(b)">{{
                      titleOf()(b)
                    }}</span>
                    @if (cameFromIds().has(b.id)) {
                      <span class="sr-only">{{ labels.back }}</span>
                    }
                    @if (rowExtra(); as extra) {
                      <ng-container
                        [ngTemplateOutlet]="extra"
                        [ngTemplateOutletContext]="{ $implicit: b }"
                      />
                    }
                  </button>
                  @if (remove()) {
                    <!-- Shown on hover or keyboard focus, always on touch. -->
                    <button
                      type="button"
                      class="icon-btn icon-btn-danger tangent-delete"
                      [attr.aria-label]="'Delete the tangent ' + titleOf()(b)"
                      title="Delete this tangent"
                      (click)="removeYours($event, b)"
                    >
                      <app-icon name="trash" [size]="13" />
                    </button>
                  }
                </div>
              }
            }
          </div>
        }
        @if (openCount() > 0 || withAsk()) {
          <div class="tangents-group tangents-offers">
            @if (foldable()) {
              <button
                type="button"
                class="tangents-fold small"
                [attr.aria-expanded]="expanded()"
                [attr.aria-controls]="ids.offersList"
                [attr.title]="locked() ? startLockedTitle() : null"
                (click)="toggle($event)"
              >
                <app-icon [name]="expanded() ? 'chevronDown' : 'chevronRight'" [size]="13" />
                {{ foldLabel() }}
              </button>
            }
            @if (openCount() > 0) {
              <div class="tangents-offers-list" [id]="ids.offersList" [hidden]="!offersShown()">
                @for (g of offerGroups(); track g.id) {
                  <div class="tangents-group" role="group" [attr.aria-labelledby]="g.id">
                    <span class="tangents-group-label muted small" [id]="g.id">{{ g.label }}</span>
                    @for (t of g.tangents; track t.title) {
                      <button
                        type="button"
                        class="tangent"
                        [class.tangent-deeper]="t.kind === 'deeper'"
                        [disabled]="opening() !== null || locked()"
                        [title]="locked() ? startLockedTitle() : followTitle"
                        (click)="follow($event, t.title)"
                      >
                        <app-icon name="tangent" [size]="14" />
                        <span class="sr-only">{{ labels.start }}</span>
                        <span class="tangent-title">{{ t.title }}</span>
                        @if (t.why) {
                          <span class="tangent-why muted">{{ t.why }}</span>
                        }
                      </button>
                    }
                  </div>
                }
              </div>
            }
            <ng-content />
          </div>
        }
      </div>
    }
  `,
})
export class SuggestionGroups {
  /** The finished reply's suggestions (none for any other message). */
  readonly tangents = input.required<readonly Tangent[]>();
  /** The branches started from the message: the user's tangents. */
  readonly children = input<readonly Branch[]>([]);
  /** The selected branch's chain: a tangent of the user's on it is lit. */
  readonly chainIds = input<ReadonlySet<string>>(new Set());
  /** The tangents the user just came back from: lit too, as the way back in. */
  readonly cameFromIds = input<ReadonlySet<string>>(new Set());
  readonly locked = input(false);
  readonly noun = input<'thread' | 'lane'>('thread');
  /** "Ask your own" is projected: the suggested group shows even with no suggestion. */
  readonly withAsk = input(false);
  /** A tangent's title as the app shows it. */
  readonly titleOf = input<(b: Branch) => string>((b) => b.title);
  /** Starts the tangent following a suggestion, and opens it. */
  readonly open = input.required<(title: string) => Promise<unknown>>();
  /** Opens one of the user's tangents. */
  readonly openBranch = input.required<(b: Branch) => void>();
  /** Asks, then deletes one of the user's tangents; null: no trash button. */
  readonly remove = input<((b: Branch) => Promise<unknown>) | null>(null);
  /** The user's tangents as chips, for a narrow card. */
  readonly compact = input(false);
  /** The app's details at the end of each of the user's tangents (not in `compact`). */
  readonly rowExtra = input<TemplateRef<{ $implicit: Branch }> | null>(null);

  protected readonly labels = {
    yours: YOUR_TANGENTS_LABEL,
    deeper: DIG_DEEPER_LABEL,
    offers: SUGGESTED_TANGENTS_LABEL,
    open: 'Open tangent: ',
    back: ' (you were just here)',
    start: 'Start a tangent: ',
  };
  protected readonly ids = {
    yours: `your-tangents-${++uid}`,
    deeper: `dig-deeper-${uid}`,
    offers: `suggested-tangents-${uid}`,
    offersList: `suggested-tangents-list-${uid}`,
  };
  protected readonly followTitle = 'Go on a tangent about this (keeps the conversation so far)';
  protected readonly footer = computed(() => tangentFooter(this.tangents(), this.children()));
  /** How many suggestions no tangent follows yet, of either kind. */
  protected readonly openCount = computed(
    () => this.footer().deeper.length + this.footer().offers.length,
  );
  /** The suggestions under their headings, leaving out an empty one. */
  protected readonly offerGroups = computed(() =>
    [
      { id: this.ids.deeper, label: this.labels.deeper, tangents: this.footer().deeper },
      { id: this.ids.offers, label: this.labels.offers, tangents: this.footer().offers },
    ].filter((g) => g.tangents.length > 0),
  );
  /** Why a suggestion can't start here, in the thread's own word. */
  protected readonly startLockedTitle = computed(
    () => `Starting a tangent needs a membership (this ${this.noun()} is on your own key)`,
  );
  /** The suggestions sit behind one button: the user has a tangent here, or none can start. */
  protected readonly foldable = computed(
    () => this.openCount() > 0 && (this.footer().folded || this.locked()),
  );
  /** The folded suggestions are shown (per message, while it is on screen). */
  protected readonly expanded = signal(false);
  protected readonly offersShown = computed(
    () => this.openCount() > 0 && (!this.foldable() || this.expanded()),
  );
  protected readonly foldLabel = computed(() =>
    suggestedFoldLabel(this.openCount(), this.footer().followed > 0),
  );
  /** The suggestions' reasons by title: a tangent following one shows it as its tooltip. */
  private readonly whyOf = computed(
    () => new Map(this.tangents().map((t) => [t.title, t.why] as const)),
  );
  /** Title of the suggestion whose tangent is opening. */
  protected readonly opening = signal<string | null>(null);

  /** A tangent's tooltip: its quote, else the reason of the suggestion it follows. */
  protected tipOf(b: Branch): string | null {
    return b.anchorQuote ?? this.whyOf().get(b.title) ?? null;
  }

  /**
   * Without a tooltip, the title shows whole on hover, since the row cuts it
   * to one line. It goes on the title rather than the button: the button's
   * name already holds the title, and a screen reader would read its tooltip
   * after it as a description.
   */
  protected fullTitleOf(b: Branch): string | null {
    return this.tipOf(b) === null ? this.titleOf()(b) : null;
  }

  protected toggle(e: Event): void {
    e.stopPropagation();
    this.expanded.update((open) => !open);
  }

  protected openYours(e: Event, b: Branch): void {
    e.stopPropagation();
    this.openBranch()(b);
  }

  protected async removeYours(e: Event, b: Branch): Promise<void> {
    e.stopPropagation();
    await this.remove()?.(b);
  }

  protected async follow(e: Event, title: string): Promise<void> {
    e.stopPropagation();
    if (this.opening() !== null || this.locked()) return;
    this.opening.set(title);
    try {
      await this.open()(title);
    } finally {
      this.opening.set(null);
    }
  }
}
