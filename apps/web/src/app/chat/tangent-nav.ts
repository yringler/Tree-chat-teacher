import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import type { Branch, ChatNode, Tangent } from '@tangent/shared';
import { SuggestionGroups, TangentAsk } from '@tangent/web-shared';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';

/**
 * The suggestions under a finished reply (`SuggestionGroups`), ending with
 * "Ask your own" while a branch can be generated on.
 */
@Component({
  selector: 'app-tangent-nav',
  imports: [SuggestionGroups, TangentAsk],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
  template: `
    <app-suggestion-groups
      [tangents]="tangents()"
      [latest]="store.isLatest(node().id)"
      [inTangent]="inTangent()"
      [children]="children()"
      [chainIds]="chainIds()"
      [locked]="locked()"
      [withAsk]="canAsk()"
      [send]="sendStep"
      [open]="openTangent"
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

  protected readonly inTangent = computed(
    () => !!this.store.branchOf(this.node().id)?.parentBranchId,
  );
  /** The reply's branch can't generate (its funding needs the membership the user lacks). */
  protected readonly locked = computed(() => this.store.nodeLocked(this.node().id));
  /** "Ask your own": offered wherever suggestions are, while a branch can be generated on. */
  protected readonly canAsk = computed(() => this.store.account.canGenerate());
  protected readonly sendStep = (title: string) => this.store.continueWith(this.node().id, title);
  protected readonly openTangent = (title: string) =>
    this.store.followTangent(this.node().id, title);
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
