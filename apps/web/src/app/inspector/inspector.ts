import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import type { ContextPlanResponse } from '@tangent/shared';
import { ApiClient, errorMessage, Icon } from '@tangent/web-shared';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { SegmentCard } from './segment-card';

type Tab = 'segments' | 'rendered';

/** Right panel: what the selected branch would send to the model at the focused message (or leaf). */
@Component({
  selector: 'app-inspector',
  imports: [Icon, SegmentCard],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './inspector.html',
  host: { class: 'inspector' },
})
export class Inspector {
  private readonly api = inject(ApiClient);
  protected readonly store = inject(TreeStore);
  protected readonly ui = inject(UiStore);

  protected readonly tab = signal<Tab>('segments');
  protected readonly data = signal<ContextPlanResponse | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly resolved = signal(false);
  private seq = 0;

  /** Inputs of the query: branch, target node (focused on the path, else the leaf), completions. */
  private readonly query = computed(
    () => ({
      branchId: this.store.selectedBranchId(),
      nodeId: this.store.focusedInPath()?.id ?? null,
      tick: this.store.completions(),
    }),
    { equal: (a, b) => a.branchId === b.branchId && a.nodeId === b.nodeId && a.tick === b.tick },
  );

  /**
   * A name for each message of the branch's path ("You 1", "Assistant 2", …),
   * for the segments' source links: node ids mean nothing to a reader.
   */
  protected readonly sourceLabels = computed<ReadonlyMap<string, string>>(() => {
    const labels = new Map<string, string>();
    this.store.path().forEach((n, i) => {
      const who = n.role === 'user' ? 'You' : n.role === 'assistant' ? 'Assistant' : 'System';
      labels.set(n.id, `${who} ${i + 1}`);
    });
    return labels;
  });

  protected readonly budgetPct = computed(() => {
    const b = this.data()?.plan.budget;
    if (!b || b.maxInputTokens <= 0) return 0;
    return Math.min(100, Math.round((b.usedTokens / b.maxInputTokens) * 100));
  });

  protected readonly pendingCount = computed(
    () =>
      this.data()?.plan.segments.filter((s) => s.kind === 'summary' && s.status !== 'ready')
        .length ?? 0,
  );

  constructor() {
    effect(() => {
      const q = this.query();
      untracked(() => {
        this.resolved.set(false);
        void this.load(q.branchId, q.nodeId, false);
      });
    });
  }

  protected resolve(): void {
    this.resolved.set(true);
    const q = this.query();
    void this.load(q.branchId, q.nodeId, true);
  }

  protected refresh(): void {
    const q = this.query();
    void this.load(q.branchId, q.nodeId, this.resolved());
  }

  protected focusNode(nodeId: string): void {
    const path = this.store.path();
    if (path.some((n) => n.id === nodeId)) this.store.focus(nodeId);
    else {
      const node = this.store.index()?.nodes.get(nodeId);
      if (node) this.store.go(node.branchId, node.id);
    }
  }

  private async load(
    branchId: string | null,
    nodeId: string | null,
    resolve: boolean,
  ): Promise<void> {
    if (!branchId) return;
    const seq = ++this.seq;
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await this.api.getContext(branchId, nodeId, resolve);
      if (seq === this.seq) this.data.set(res);
    } catch (err) {
      if (seq === this.seq) this.error.set(errorMessage(err));
    } finally {
      if (seq === this.seq) this.loading.set(false);
    }
  }
}
