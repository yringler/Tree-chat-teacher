import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  type OnDestroy,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import type { Branch, ChatNode, MembershipInfo } from '@tangent/shared';
import { describeEndpoint } from '@tangent/core';
import {
  endpointTitle,
  Icon,
  PendingQuote,
  ReadOnlyComposer,
  SelectionAsk,
  selectedMessageQuote,
  TextSizeStore,
  type MessageQuote,
} from '@tangent/web-shared';
import { Inspector } from '../inspector/inspector';
import { TierStore } from '../state/tier-store';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { ModeBadge } from '../ui/mode-badge';
import { ChatHeader } from './chat-header';
import { Composer } from './composer';
import { MessageItem } from './message-item';
import { RouteBar } from './route-bar';

interface Entry {
  node: ChatNode;
  ancestor: boolean;
  /** Set on the first message of each branch after the trunk: the branch it starts. */
  divider: Branch | null;
}

/** `/t/:treeId[/b/:branchId]`: linear view of the selected branch path. */
@Component({
  selector: 'app-chat-page',
  imports: [
    ChatHeader,
    Composer,
    Icon,
    MessageItem,
    ModeBadge,
    Inspector,
    ReadOnlyComposer,
    RouteBar,
    RouterLink,
    SelectionAsk,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './chat-page.html',
  host: {
    class: 'page chat-page',
    '(document:selectionchange)': 'selection.update()',
  },
})
export class ChatPage implements OnDestroy {
  protected readonly store = inject(TreeStore);
  protected readonly ui = inject(UiStore);
  private readonly tiers = inject(TierStore);
  /** The user's text size for the messages and composer (see chat.css). */
  protected readonly textSize = inject(TextSizeStore);
  private readonly title = inject(Title);
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  /** True while the view is scrolled to (near) the bottom: new text keeps it pinned. */
  private readonly pinned = signal(true);
  /**
   * Text selected in a finished message: offers "Ask about this" (a `path`
   * branch quoting it, opened ready to type) and, by its gear, the full
   * "Branch from here" dialog with the quote filled in.
   */
  protected readonly selection = new PendingQuote(() => this.quoteToAsk());
  protected readonly asking = signal(false);

  protected readonly chainIds = computed<ReadonlySet<string>>(
    () => new Set(this.store.chain().map((b) => b.id)),
  );

  protected readonly entries = computed<Entry[]>(() => {
    const selected = this.store.selectedBranchId();
    const idx = this.store.index();
    let prevBranch: string | null = null;
    return this.store.path().map((node) => {
      const divider =
        prevBranch !== null && node.branchId !== prevBranch
          ? (idx?.branches.get(node.branchId) ?? null)
          : null;
      prevBranch = node.branchId;
      return { node, ancestor: node.branchId !== selected, divider };
    });
  });

  /** Non-trunk branch without messages of its own: show its fork divider at the end. */
  protected readonly emptyBranch = computed<Branch | null>(() => {
    const b = this.store.selectedBranch();
    if (!b?.parentBranchId) return null;
    return (this.store.index()?.nodesByBranch.get(b.id)?.length ?? 0) === 0 ? b : null;
  });

  /**
   * The composer continues the open branch; asking about something new is a
   * branch ("Ask your own question…" under the reply, "Ask about this" on a
   * selection), so the box says what it does rather than inviting every question.
   */
  protected readonly placeholder = computed(() => {
    const b = this.store.selectedBranch();
    if (!b) return 'Message…';
    if (this.store.path().length === 0) return 'Start the conversation…';
    // A new branch without messages: the next one starts it.
    if (this.emptyBranch()) return 'Ask your question…';
    return 'Continue this thread…';
  });

  /**
   * The selection's message is on a route that needs the membership: only
   * the dialog can pick another one.
   */
  protected readonly selectionLocked = computed(() => {
    const q = this.selection.value();
    const node = q ? this.store.index()?.nodes.get(q.nodeId) : undefined;
    const branch = node ? this.store.index()?.branches.get(node.branchId) : undefined;
    return !!branch && this.store.account.routeLocked(branch);
  });

  /** A message of the open branch that couldn't be sent: the composer takes it back. */
  protected readonly initialDraft = computed(() => {
    const id = this.store.selectedBranchId();
    return (id && this.store.unsentDrafts().get(id)) || '';
  });

  /** Compare is offered: Normal and Max are two models the open branch can use, and it is idle. */
  protected readonly canCompare = computed(
    () => !this.store.busy() && this.tiers.available(this.store.selectedBranch()),
  );

  /** Pick mode, with what the message being linked from says (for the banner). */
  protected readonly picking = computed(() => {
    const pick = this.ui.linkPick();
    const idx = this.store.index();
    const from = pick && idx ? describeEndpoint(idx, pick.fromNodeId) : null;
    if (!pick || !from) return null;
    const title = endpointTitle(from);
    return {
      fromNodeId: pick.fromNodeId,
      title: title.length > 60 ? `${title.slice(0, 59).trimEnd()}…` : title,
    };
  });

  /**
   * The selected branch is read-only (its funding needs the membership the
   * user lacks): what the notice standing in for the composer needs.
   */
  protected readonly readOnly = computed<{ membership: MembershipInfo; treeId: string } | null>(
    () => {
      const membership = this.store.account.membership();
      const treeId = this.store.detail()?.tree.id;
      return this.store.readOnly() && membership && treeId ? { membership, treeId } : null;
    },
  );

  constructor() {
    effect(() => {
      const t = this.store.detail()?.tree.title;
      this.title.setTitle(t ? `${t} · Tangent` : 'Tangent');
    });

    // Scroll to the focused message, or to the bottom when switching branches;
    // new messages only scroll when the view is pinned to the bottom.
    let lastBranch: string | null = null;
    let lastFocus: string | null = null;
    effect(() => {
      const branchId = this.store.selectedBranchId();
      const focus = this.store.focusedInPath()?.id ?? null;
      const count = this.store.path().length;
      if (!branchId || count === 0) return;
      const moved = branchId !== lastBranch || focus !== lastFocus;
      lastBranch = branchId;
      lastFocus = focus;
      if (moved) this.selection.clear();
      if (moved || untracked(this.pinned)) {
        if (moved && !focus) this.pinned.set(true);
        requestAnimationFrame(() => this.scrollTo(moved ? focus : null));
      }
    });

    // Keep the view pinned to the bottom while a reply streams in.
    effect(() => {
      const s = this.store.streamingNode();
      const live = s ? this.store.live().get(s.id)?.content : undefined;
      if (live === undefined || !untracked(this.pinned)) return;
      requestAnimationFrame(() => this.scrollTo(null));
    });
  }

  ngOnDestroy(): void {
    this.selection.destroy();
  }

  /** "Ask about this": a `path` branch quoting the selection, opened with the composer focused. */
  protected async askAbout(q: MessageQuote): Promise<void> {
    if (this.selectionLocked()) {
      this.moreAbout(q);
      return;
    }
    this.selection.clear();
    window.getSelection()?.removeAllRanges();
    this.asking.set(true);
    try {
      await this.store.createBranch({
        fromNodeId: q.nodeId,
        contextMode: 'path',
        anchorQuote: q.quote,
      });
    } finally {
      this.asking.set(false);
    }
  }

  /** The gear: "Branch from here" with the quote filled in (mode, model, starting message…). */
  protected moreAbout(q: MessageQuote): void {
    this.selection.clear();
    window.getSelection()?.removeAllRanges();
    this.ui.branchDialog.set({ fromNodeId: q.nodeId, quote: q.quote });
  }

  /** The quote under the selection, when it lies in one finished message and branches can be made. */
  private quoteToAsk(): MessageQuote | null {
    if (!this.store.account.canGenerate() || this.ui.anyDialogOpen()) return null;
    const found = selectedMessageQuote(this.scroller()?.nativeElement, window.getSelection());
    const node = found ? this.store.index()?.nodes.get(found.nodeId) : undefined;
    return node?.status === 'complete' ? found : null;
  }

  protected onScroll(el: HTMLElement): void {
    this.pinned.set(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  }

  protected searchInstead(fromNodeId: string): void {
    this.ui.linkPick.set(null);
    this.ui.linkDialog.set({ fromNodeId });
  }

  protected send(content: string): void {
    const id = this.store.selectedBranchId();
    if (!id) return;
    this.pinned.set(true);
    if (this.store.focusedNodeId()) this.store.focus(null);
    void this.store.send(id, content);
  }

  /** Compare: Normal and Max answer the message in a dialog; the text stays until one is kept. */
  protected compare(content: string): void {
    const branchId = this.store.selectedBranchId();
    if (!branchId) return;
    this.ui.compareDialog.set({ branchId, content });
  }

  /** "Continue with Tangent credit": the selected branch moves onto credit and its composer returns. */
  protected useCredit(): void {
    const id = this.store.selectedBranchId();
    if (id) void this.store.switchToCredit(id);
  }

  protected stop(): void {
    const n = this.store.streamingNode();
    if (n) void this.store.cancel(n.id);
  }

  private scrollTo(nodeId: string | null): void {
    const el = this.scroller()?.nativeElement;
    if (!el) return;
    if (nodeId) {
      document
        .getElementById(`msg-${nodeId}`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }
}
