import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  type OnDestroy,
  signal,
  viewChild,
} from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { clip, REPLY_ACTION, type MembershipInfo } from '@tangent/shared';
import { describeEndpoint } from '@tangent/core';
import {
  Composer,
  endpointTitle,
  Icon,
  JumpToEnd,
  PendingQuote,
  ReadOnlyComposer,
  selectedMessageQuote,
  SelectionAsk,
  TextSizeStore,
  ThreadScroll,
  type MessageQuote,
} from '@tangent/web-shared';
import { Inspector } from '../inspector/inspector';
import { TierStore } from '../state/tier-store';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { ModeBadge } from '../ui/mode-badge';
import { ChatHeader } from './chat-header';
import { MessageItem } from './message-item';
import { RouteBar } from './route-bar';

/** `/t/:treeId[/b/:branchId]`: linear view of the selected branch path. */
@Component({
  selector: 'app-chat-page',
  imports: [
    ChatHeader,
    Composer,
    Icon,
    JumpToEnd,
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
  /**
   * Text selected in a finished message: offers "Ask about this" (a `path`
   * branch quoting it, opened ready to type) and, by its gear, the full
   * "Branch from here" dialog with the quote filled in.
   */
  protected readonly selection = new PendingQuote(() => this.quoteToAsk());
  protected readonly asking = signal(false);
  /** Where the conversation is scrolled. */
  protected readonly thread = new ThreadScroll({
    store: this.store,
    scroller: () => this.scroller()?.nativeElement,
    moved: () => this.selection.clear(),
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
    if (this.store.emptyBranch()) return 'Ask your question…';
    return 'Continue this thread…';
  });

  /**
   * Send's hint once there is a thread: sending is its next step (power
   * starts tangents from a message's Tangent ↳ instead).
   */
  protected readonly sendTitle = computed(() => {
    const b = this.store.selectedBranch();
    if (!b || this.store.path().length === 0) return null;
    const hint = b.parentBranchId ? REPLY_ACTION.hintInTangent : REPLY_ACTION.hint;
    return `${REPLY_ACTION.label}: ${hint}`;
  });

  /**
   * The selection's message is on a route that needs the membership: only
   * the dialog can pick another one.
   */
  protected readonly selectionLocked = computed(() => {
    const q = this.selection.value();
    return !!q && this.store.nodeLocked(q.nodeId);
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
      title: clip(title, 60),
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
    this.ui.dialogs.open({ kind: 'branch', fromNodeId: q.nodeId, quote: q.quote });
  }

  /** The quote under the selection, when it lies in one finished message and branches can be made. */
  private quoteToAsk(): MessageQuote | null {
    if (!this.store.account.canGenerate() || this.ui.dialogs.anyOpen()) return null;
    const found = selectedMessageQuote(this.scroller()?.nativeElement, window.getSelection());
    const node = found ? this.store.index()?.nodes.get(found.nodeId) : undefined;
    return node?.status === 'complete' ? found : null;
  }

  protected searchInstead(fromNodeId: string): void {
    this.ui.linkPick.set(null);
    this.ui.dialogs.open({ kind: 'link', fromNodeId });
  }

  protected send(content: string): void {
    const id = this.store.selectedBranchId();
    if (!id) return;
    this.thread.pin();
    if (this.store.focusedNodeId()) this.store.focus(null);
    void this.store.send(id, content);
  }

  /** Compare: Normal and Max answer the message in a dialog; the text stays until one is kept. */
  protected compare(content: string): void {
    const branchId = this.store.selectedBranchId();
    if (!branchId) return;
    this.ui.dialogs.open({ kind: 'compare', branchId, content });
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
}
