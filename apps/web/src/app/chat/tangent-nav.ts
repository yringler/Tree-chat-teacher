import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import type { Branch, ChatNode, Tangent } from '@tangent/shared';
import { Icon, SuggestionGroups } from '@tangent/web-shared';
import { confirmDeleteBranch } from '../dialogs/branch-settings';
import { TreeStore } from '../state/tree-store';
import { ModeBadge } from '../ui/mode-badge';

/**
 * The footer under a message (`SuggestionGroups`): the tangents started
 * from it, with their mode, privacy and size, for any message (power
 * branches from questions and failed replies too), and a finished reply's
 * suggestions. A question of the user's own goes in the message box, aimed
 * at the reply by its Tangent ↳.
 */
@Component({
  selector: 'app-tangent-nav',
  imports: [Icon, ModeBadge, SuggestionGroups],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
  template: `
    <app-suggestion-groups
      [tangents]="suggestions()"
      [children]="children()"
      [chainIds]="chainIds()"
      [cameFromIds]="store.cameFromIds()"
      [locked]="locked()"
      [open]="openTangent"
      [openBranch]="openBranch"
      [remove]="removeBranch"
      [rowExtra]="details"
    />
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

  readonly node = input.required<ChatNode>();
  /** A finished reply: it offers its suggestions. */
  readonly finished = input(false);
  readonly tangents = input.required<readonly Tangent[]>();
  /** The branches started from the message. */
  readonly children = input.required<readonly Branch[]>();
  /** The selected branch's chain (a tangent on it is lit). */
  readonly chainIds = input<ReadonlySet<string>>(new Set());

  protected readonly suggestions = computed(() => (this.finished() ? this.tangents() : []));
  /** A tangent from the message would start on a route the membership locks. */
  protected readonly locked = computed(() => this.store.tangentLocked(this.node().id));
  protected readonly openTangent = (title: string) =>
    this.store.followTangent(this.node().id, title);
  protected readonly openBranch = (b: Branch) => this.store.openAtStart(b.id);
  protected readonly removeBranch = (b: Branch) => confirmDeleteBranch(this.store, b.id);

  /** How many messages a tangent has of its own. */
  protected countOf(branchId: string): number {
    return this.store.index()?.nodesByBranch.get(branchId)?.length ?? 0;
  }
}
