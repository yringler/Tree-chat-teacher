import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  OnDestroy,
  untracked,
} from '@angular/core';
import { branchLeaf } from '@tangent/core/tree';
import type { ChatNode } from '@tangent/shared';
import {
  Composer,
  CONTEXT_MODE_META,
  Icon,
  ReadOnlyComposer,
  TextSizeStore,
} from '@tangent/web-shared';
import type { LanePlacement } from '../layout/layout';
import { LayoutStore } from '../layout/layout-store';
import { CanvasStore, modelLabel, type Lineage } from '../state/canvas-store';
import { UiStore } from '../state/ui-store';
import { Card, type Lit } from './card';
import { confirmDeleteLane } from './delete-lane';
import { laneTitle } from './titles';

/**
 * One branch as a column on the canvas: its head (title, context mode,
 * model, what the model sees), its message cards and its own composer, so
 * any number of lanes can be written in and read at once. The lane reports
 * its measured box to the LayoutStore after every render, which is how the
 * layout knows where child lanes and connectors go.
 */
@Component({
  selector: 'app-lane',
  imports: [Icon, Card, Composer, ReadOnlyComposer],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let b = place().branch;
    @let selected = isSelected();
    @let onChain = store.chainIds().has(b.id);
    @let parentId = b.parentBranchId;
    <header class="lane-head mode-head-{{ b.contextMode }}">
      <div class="lane-head-row">
        @if (parentId) {
          <button
            type="button"
            class="icon-btn lane-up"
            title="Back to the message this lane branches from"
            aria-label="Parent lane"
            (click)="toParent($event)"
          >
            <app-icon name="back" [size]="14" />
          </button>
        }
        <h2 class="lane-title" [attr.title]="laneTitle(b)">{{ laneTitle(b) }}</h2>
        @if (busy()) {
          <span class="lane-live" title="A reply is being written in this lane">
            <span class="dot-live"></span>
          </span>
        }
        @if (hasChildren()) {
          <button
            type="button"
            class="icon-btn"
            [attr.title]="
              place().collapsed
                ? 'Unfold the ' + place().hiddenBranches + ' lanes below'
                : 'Fold the lanes below into this one'
            "
            [attr.aria-label]="place().collapsed ? 'Unfold' : 'Fold'"
            (click)="toggleFold($event)"
          >
            <app-icon [name]="place().collapsed ? 'chevronRight' : 'chevronDown'" [size]="15" />
          </button>
        }
        <button
          type="button"
          class="icon-btn"
          title="Lane settings: title, context, model"
          aria-label="Lane settings"
          (click)="settings($event)"
        >
          <app-icon name="settings" [size]="15" />
        </button>
        @if (parentId) {
          <button
            type="button"
            class="icon-btn icon-btn-danger"
            [attr.title]="
              hasChildren() ? 'Delete this lane and the lanes below it' : 'Delete this lane'
            "
            [attr.aria-label]="'Delete the lane ' + laneTitle(b)"
            (click)="remove($event)"
          >
            <app-icon name="trash" [size]="14" />
          </button>
        }
      </div>
      <div class="lane-meta">
        <span class="badge mode-{{ b.contextMode }}" [attr.title]="modes[b.contextMode].longHelp">
          {{ modes[b.contextMode].label }}
        </span>
        <span
          class="badge"
          [attr.title]="
            b.providerId + (b.funding === 'credit' ? ' (Tangent credit)' : '') + ' · ' + b.model
          "
          >{{ model() }}</span
        >
        @if (b.isPrivate) {
          <span class="badge" title="Private: left out of shares and exports"
            ><app-icon name="lock" [size]="10" /> private</span
          >
        }
        @if (summaryState(); as s) {
          <span class="badge status-{{ s }}" title="The summary of the parent context">
            summary {{ s }}
          </span>
        }
      </div>
      @if (selected && lineage(); as l) {
        <div
          class="budget"
          [attr.title]="
            'About ' +
            l.plan.budget.usedTokens.toLocaleString() +
            ' of ' +
            l.plan.budget.maxInputTokens.toLocaleString() +
            ' input tokens would be sent'
          "
        >
          <span class="budget-bar" [style.width.%]="budgetPct()"></span>
        </div>
      }
      @if (b.anchorQuote) {
        <blockquote class="anchor">{{ b.anchorQuote }}</blockquote>
      }
    </header>

    @if (place().collapsed) {
      <button type="button" class="capsule" (click)="toggleFold($event)">
        <app-icon name="branch" [size]="14" />
        {{ nodes().length }} {{ nodes().length === 1 ? 'message' : 'messages' }} ·
        {{ place().hiddenBranches }} {{ place().hiddenBranches === 1 ? 'lane' : 'lanes' }} folded
      </button>
    } @else {
      <div class="lane-cards" [class.is-compact]="!selected && !onChain">
        @if (nodes().length === 0) {
          <p class="lane-empty muted small">
            {{ parentId ? 'Nothing here yet: ask below.' : 'Start the conversation below.' }}
          </p>
        }
        @for (n of nodes(); track n.id) {
          <app-card [node]="n" [focused]="n.id === store.focusedNodeId()" [lit]="litOf(n)" />
        }
      </div>
      @if (store.account.routeLocked(b) && store.account.membership(); as membership) {
        <!-- The lane's funding needs the membership the user lacks: read it, renew, or open it in Learn. -->
        <app-read-only-composer
          [compact]="true"
          [membership]="membership"
          [treeId]="b.treeId"
          [branchId]="b.id"
          [credit]="store.account.creditRoute() !== null"
          [learn]="store.account.learnWay()"
          (useCredit)="store.switchToCredit(b.id)"
          (pointerdown)="$event.stopPropagation()"
        />
      } @else {
        <!-- Typing in the box neither selects the lane nor starts a pan. -->
        <app-composer
          [inputId]="'composer-' + b.id"
          [branchId]="b.id"
          [compact]="true"
          [maxHeight]="220"
          [placeholder]="nodes().length === 0 ? 'Ask here…' : 'Continue this lane…'"
          [disabled]="busy()"
          [busy]="streaming() !== null"
          [current]="selected"
          (pointerdown)="boxDown($event)"
          [initial]="store.unsentDrafts().get(b.id) ?? ''"
          (send)="send($event)"
          (stop)="stop()"
        />
      }
    }
  `,
  host: {
    class: 'lane',
    '[class.is-selected]': 'isSelected()',
    '[class.is-chain]': 'store.chainIds().has(place().branch.id)',
    '[class.is-collapsed]': 'place().collapsed',
    '[style.transform]': '"translate(" + place().x + "px, " + place().y + "px)"',
    '[style.width.px]': 'place().width',
    '[attr.data-branch-id]': 'place().branch.id',
    '(pointerdown)': 'select()',
  },
})
export class Lane implements OnDestroy {
  protected readonly store = inject(CanvasStore);
  private readonly ui = inject(UiStore);
  private readonly layout = inject(LayoutStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly textSize = inject(TextSizeStore);
  protected readonly laneTitle = laneTitle;
  protected readonly modes = CONTEXT_MODE_META;

  readonly place = input.required<LanePlacement>();
  readonly lineage = input<Lineage | null>(null);
  /** The lineage view is on (cards outside the plan dim). */
  readonly lineageOn = input(false);

  private observer: ResizeObserver | null = null;

  protected readonly isSelected = computed(
    () => this.store.selectedBranchId() === this.place().branch.id,
  );
  protected readonly nodes = computed<readonly ChatNode[]>(
    () => this.store.index()?.nodesByBranch.get(this.place().branch.id) ?? [],
  );
  /** `place()` is a new object after every layout pass; this only changes when the fold does. */
  private readonly collapsed = computed(() => this.place().collapsed);
  protected readonly hasChildren = computed(
    () => (this.store.index()?.childBranches.get(this.place().branch.id)?.length ?? 0) > 0,
  );
  protected readonly streaming = computed(
    () => this.nodes().find((n) => n.status === 'streaming') ?? null,
  );
  protected readonly busy = computed(() => this.store.busyBranches().has(this.place().branch.id));
  protected readonly model = computed(() => {
    const b = this.place().branch;
    return modelLabel(this.store.account.providers(), b, b.model);
  });
  protected readonly budgetPct = computed(() => {
    const l = this.lineage();
    if (!l) return 0;
    const { usedTokens, maxInputTokens } = l.plan.budget;
    return Math.min(100, Math.round((100 * usedTokens) / Math.max(1, maxInputTokens)));
  });
  /** Status of the summary segment a summary-mode lane sends, from its own plan. */
  protected readonly summaryState = computed(() => {
    const l = this.lineage();
    if (!l || !this.isSelected() || this.place().branch.contextMode !== 'summary') return null;
    const seg = l.plan.segments.find((s) => s.kind === 'summary' && s.purpose === 'branch');
    return seg && seg.kind === 'summary' ? seg.status : null;
  });

  constructor() {
    // Re-measure whenever the lane's content changes shape: cards added or
    // removed, folded, selected (compact cards open up), the lineage toggled
    // (badges) or the text size changed (every card rewraps). The arguments
    // only make the effect depend on them; it must not re-run on every layout
    // pass, and the ResizeObserver covers everything else.
    afterRenderEffect(() =>
      this.measure(
        this.nodes().length,
        this.collapsed(),
        this.isSelected(),
        this.lineageOn(),
        this.textSize.scale(),
      ),
    );
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    this.layout.forget(this.place().branch.id);
  }

  /** The lineage view's reading of one of this lane's cards. */
  protected litOf(n: ChatNode): Lit {
    if (!this.lineageOn()) return 'off';
    const l = this.lineage();
    if (!l) return 'off';
    if (l.verbatim.has(n.id)) return 'verbatim';
    if (l.summarized.has(n.id)) return 'summarized';
    if (l.dropped.has(n.id)) return 'dropped';
    // Messages of the selected lane after the plan's leaf (still streaming) count as sent.
    if (n.branchId === l.branchId) return 'verbatim';
    return 'outside';
  }

  /** Pointer down anywhere on the lane selects it, without moving the camera mid-gesture. */
  /** A pointer down in the lane's text box stays there: no lane select, no pan. */
  protected boxDown(e: PointerEvent): void {
    if (e.target instanceof HTMLTextAreaElement) e.stopPropagation();
  }

  protected select(): void {
    if (this.isSelected()) return;
    const id = this.place().branch.id;
    this.layout.pointerSelect = id;
    this.store.go(id);
  }

  protected toParent(e: Event): void {
    e.stopPropagation();
    const b = this.place().branch;
    if (b.parentBranchId) this.store.go(b.parentBranchId, b.branchPointNodeId);
  }

  protected toggleFold(e: Event): void {
    e.stopPropagation();
    this.ui.toggleCollapsed(this.place().branch.id);
  }

  protected settings(e: Event): void {
    e.stopPropagation();
    this.ui.dialogs.open({ kind: 'branch-settings', branchId: this.place().branch.id });
  }

  /** The lane with every lane below it, after asking; the selection moves up if it was in there. */
  protected remove(e: Event): void {
    e.stopPropagation();
    void confirmDeleteLane(this.store, this.place().branch.id);
  }

  protected send(content: string): void {
    const b = this.place().branch;
    if (!this.isSelected()) this.store.go(b.id);
    void this.store.send(b.id, content);
  }

  protected stop(): void {
    const idx = this.store.index();
    const leaf = idx ? branchLeaf(idx, this.place().branch.id) : null;
    const n = this.streaming() ?? (leaf?.status === 'streaming' ? leaf : null);
    if (n) void this.store.cancel(n.id);
  }

  private measure(
    _cards: number,
    _collapsed: boolean,
    _selected: boolean,
    _lineage: boolean,
    _textScale: number,
  ): void {
    const el = this.host.nativeElement;
    if (!this.observer) {
      this.observer = new ResizeObserver(() => this.report());
      this.observer.observe(el);
    }
    // Untracked: `place()` and the measures it reads are not reasons to re-measure.
    untracked(() => this.report());
  }

  private report(): void {
    const el = this.host.nativeElement;
    const cards = new Map<string, { top: number; height: number }>();
    for (const card of el.querySelectorAll<HTMLElement>('[data-node-id]')) {
      const id = card.dataset['nodeId'];
      if (id) cards.set(id, { top: card.offsetTop, height: card.offsetHeight });
    }
    this.layout.measured(this.place().branch.id, { height: el.offsetHeight, cards });
  }
}
