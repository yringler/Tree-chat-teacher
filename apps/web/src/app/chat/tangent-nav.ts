import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import type { Branch, ChatNode, Tangent } from '@tangent/shared';
import { Icon, TangentAsk } from '@tangent/web-shared';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';

/**
 * "Where next?" under a finished reply: the tangents it suggested (each a
 * branch to follow, or the one already following it) and "Ask your own".
 */
@Component({
  selector: 'app-tangent-nav',
  imports: [Icon, TangentAsk],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
  template: `
    @if (tangents().length > 0 || canAsk()) {
      <nav class="tangents" aria-label="Tangents worth following">
        <span class="tangents-label muted small">Where next?</span>
        @for (t of tangents(); track t.title) {
          <button
            type="button"
            class="tangent"
            [class.is-followed]="followed().has(t.title)"
            [class.is-on]="followedOn().has(t.title)"
            [disabled]="opening() !== null || (locked() && !followed().has(t.title))"
            [title]="
              followed().has(t.title)
                ? 'Open the branch that follows this'
                : locked()
                  ? 'Following it needs a membership (this branch is on your own key)'
                  : 'Branch off and ask about this (keeps the conversation so far)'
            "
            (click)="follow($event, t.title)"
          >
            <app-icon [name]="followed().has(t.title) ? 'chevronRight' : 'branch'" [size]="14" />
            <span class="tangent-title">{{ t.title }}</span>
            @if (t.why) {
              <span class="tangent-why muted">{{ t.why }}</span>
            }
          </button>
        }
        @if (canAsk()) {
          <!-- The user's own question, branched off like a tangent. -->
          <app-tangent-ask
            [(text)]="askText"
            label="Ask your own question in a new branch"
            settingsLabel="Branch settings: context, model, quote…"
            [expandable]="true"
            [reveal]="true"
            [busy]="asking()"
            [latest]="store.isLatest(node().id)"
            [disabled]="locked()"
            disabledTitle="Asking needs a membership (this branch is on your own key)"
            (ask)="ask($event)"
            (settings)="askWithSettings($event)"
            (click)="$event.stopPropagation()"
          />
        }
      </nav>
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

  /** The reply's branch can't generate (its funding needs the membership the user lacks). */
  protected readonly locked = computed(() => this.store.nodeLocked(this.node().id));
  /** Titles of the tangents already followed (a child branch carries the title). */
  protected readonly followed = computed<ReadonlySet<string>>(() => {
    const titles = new Set(this.tangents().map((t) => t.title));
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
  /** "Ask your own": offered wherever tangents are, while a branch can be generated on. */
  protected readonly canAsk = computed(() => this.store.account.canGenerate());
  /** Title of the tangent whose branch is being created. */
  protected readonly opening = signal<string | null>(null);
  protected readonly askText = signal('');
  protected readonly asking = signal(false);

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

  /** The gear: the branch dialog, sending the question once the branch is set up. */
  protected askWithSettings(text: string): void {
    this.ui.dialogs.open({
      kind: 'branch',
      fromNodeId: this.node().id,
      quote: null,
      ...(text ? { message: text, onCreated: () => this.askText.set('') } : {}),
    });
  }
}
