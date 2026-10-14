import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import type { Branch, ChatNode, Tangent } from '@tangent/shared';
import { Icon, SuggestionGroups, TangentAsk } from '@tangent/web-shared';
import { confirmDeleteBranch } from '../dialogs/branch-settings';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { ModeBadge } from '../ui/mode-badge';

/**
 * The footer under a message (`SuggestionGroups`): the tangents started
 * from it, with their mode, privacy and size, for any message (power
 * branches from questions and failed replies too); a finished reply's
 * suggestions, ending with "Ask your own" while a branch can be generated on.
 */
@Component({
  selector: 'app-tangent-nav',
  imports: [Icon, ModeBadge, SuggestionGroups, TangentAsk],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
  template: `
    <app-suggestion-groups
      [tangents]="suggestions()"
      [latest]="store.isLatest(node().id)"
      [inTangent]="inTangent()"
      [children]="children()"
      [chainIds]="chainIds()"
      [locked]="locked()"
      [withAsk]="canAsk()"
      [send]="sendStep"
      [open]="openTangent"
      [openBranch]="openBranch"
      [remove]="removeBranch"
      [rowExtra]="details"
    >
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
    </app-suggestion-groups>
    <ng-template #details let-b>
      <app-mode-badge [mode]="b.contextMode" />
      @if (b.isPrivate) {
        <app-icon name="lock" [size]="12" />
      }
      <span class="count">{{ countOf(b.id) }}</span>
    </ng-template>
  `,
})
export class TangentNav {
  protected readonly store = inject(TreeStore);
  private readonly ui = inject(UiStore);

  readonly node = input.required<ChatNode>();
  /** A finished reply: it offers its suggestions and "Ask your own". */
  readonly finished = input(false);
  readonly tangents = input.required<readonly Tangent[]>();
  /** The branches started from the message. */
  readonly children = input.required<readonly Branch[]>();
  /** The selected branch's chain (a tangent on it is lit). */
  readonly chainIds = input<ReadonlySet<string>>(new Set());

  protected readonly suggestions = computed(() => (this.finished() ? this.tangents() : []));
  protected readonly inTangent = computed(
    () => !!this.store.branchOf(this.node().id)?.parentBranchId,
  );
  /** The message's branch can't generate (its funding needs the membership the user lacks). */
  protected readonly locked = computed(() => this.store.nodeLocked(this.node().id));
  /** "Ask your own": offered under a finished reply, while a branch can be generated on. */
  protected readonly canAsk = computed(() => this.finished() && this.store.account.canGenerate());
  protected readonly sendStep = (title: string) => this.store.continueWith(this.node().id, title);
  protected readonly openTangent = (title: string) =>
    this.store.followTangent(this.node().id, title);
  protected readonly openBranch = (b: Branch) => this.store.openAtStart(b.id);
  protected readonly removeBranch = (b: Branch) => confirmDeleteBranch(this.store, b.id);
  protected readonly askText = signal('');
  protected readonly asking = signal(false);

  /** How many messages a tangent has of its own. */
  protected countOf(branchId: string): number {
    return this.store.index()?.nodesByBranch.get(branchId)?.length ?? 0;
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
