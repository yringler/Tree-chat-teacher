import { NgTemplateOutlet } from '@angular/common';
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
import { describeEndpoint } from '@tangent/core/links';
import type { Branch, ChatNode } from '@tangent/shared';
import {
  Icon,
  PendingQuote,
  PoolBlockNotice,
  SelectionAsk,
  selectedMessageQuote,
  TextSizeMenu,
  TextSizeStore,
  type MessageQuote,
} from '@tangent/web-shared';
import { BRAND } from '../brand';
import { AccountStore } from '../state/account-store';
import { LessonStore } from '../state/lesson-store';
import { Composer } from './composer';
import { connectionTitleOf } from './connections';
import { confirmDeleteSideQuestion } from './delete-side-question';
import { FundingToggle, type FundingOption } from './funding-toggle';
import { MessageItem } from './message-item';
import { ModelToggle } from './model-toggle';
import { branchTitle, lessonTitle } from './titles';

interface Entry {
  node: ChatNode;
  ancestor: boolean;
  /** Set on the first message of each side question: the branch it starts. */
  divider: Branch | null;
}

/** `/t/:treeId[/b/:branchId]`: the lesson, one branch at a time. */
@Component({
  selector: 'app-chat-page',
  imports: [
    Composer,
    FundingToggle,
    MessageItem,
    ModelToggle,
    Icon,
    PoolBlockNotice,
    RouterLink,
    NgTemplateOutlet,
    SelectionAsk,
    TextSizeMenu,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './chat-page.html',
  host: {
    class: 'page chat-page',
    // The learner's text size for the lesson's messages and composer (styles.css).
    '[style.--chat-font-scale]': 'textSize.scale()',
    '(document:selectionchange)': 'pendingAsk.update()',
  },
})
export class ChatPage implements OnDestroy {
  protected readonly store = inject(LessonStore);
  protected readonly account = inject(AccountStore);
  protected readonly textSize = inject(TextSizeStore);
  private readonly title = inject(Title);
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  /** True while the view is scrolled to (near) the bottom: new text keeps it pinned. */
  private readonly pinned = signal(true);
  protected readonly switching = signal(false);
  /** Text selected inside one finished message: offers "Ask about this". */
  protected readonly pendingAsk = new PendingQuote(() => this.selectedQuote());

  protected readonly branchTitle = branchTitle;
  /** The lesson's title in the learner's words ("New lesson" until the first reply names it). */
  protected readonly lessonTitle = computed(() => {
    const t = this.store.detail()?.tree.title;
    return t === undefined ? '' : lessonTitle(t);
  });

  /**
   * "Back to …" after following a connection, while still on the branch it
   * went to: named after the message it was followed from.
   */
  protected readonly linkReturn = computed<{ label: string } | null>(() => {
    const back = this.store.linkReturn();
    if (back && back.toBranchId !== this.store.selectedBranchId()) return null;
    const idx = this.store.index();
    const from = back && idx ? describeEndpoint(idx, back.nodeId, connectionTitleOf) : null;
    if (!from) return null;
    return { label: from.snippet || connectionTitleOf(from.branch) };
  });

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

  /** A side question without messages yet: show where it starts at the end. */
  protected readonly emptyBranch = computed<Branch | null>(() => {
    const b = this.store.selectedBranch();
    if (!b?.parentBranchId) return null;
    return (this.store.index()?.nodesByBranch.get(b.id)?.length ?? 0) === 0 ? b : null;
  });

  /**
   * The message box continues what is open; a new question is a side question
   * ("Ask your own question…" under the reply, "Ask about this" on a selection).
   */
  protected readonly placeholder = computed(() => {
    const b = this.store.selectedBranch();
    if (!b || this.store.path().length === 0) return 'What do you want to learn?';
    if (b.parentBranchId && this.emptyBranch()) return 'Ask your side question…';
    return b.parentBranchId ? 'Continue this side question…' : 'Continue this lesson…';
  });

  /** The pool's refusal of a message in this branch (empty or a cap), shown above the composer. */
  protected readonly poolBlock = computed(() => {
    const block = this.store.poolBlock();
    return block && block.branchId === this.store.selectedBranchId() ? block : null;
  });

  protected readonly funding = computed<FundingOption>(() =>
    this.account.payment.payment() === 'pool' ? 'pool' : 'credit',
  );

  /** A message refused for lack of credit, offered back after a top-up. */
  protected readonly initialDraft = computed(() => {
    const d = this.store.unsentDraft();
    return d && d.branchId === this.store.selectedBranchId() ? d.text : '';
  });

  constructor() {
    effect(() => {
      const t = this.lessonTitle();
      this.title.setTitle(t ? `${t} · ${BRAND}` : BRAND);
    });

    // Scroll to the focused message, or to the bottom when switching branches;
    // new messages only scroll when the view is pinned to the bottom.
    let lastBranch: string | null = null;
    let lastFocus: string | null = null;
    effect(() => {
      const branchId = this.store.selectedBranchId();
      const focus = this.store.focusedNodeId();
      const count = this.store.path().length;
      if (!branchId || count === 0) return;
      const moved = branchId !== lastBranch || focus !== lastFocus;
      lastBranch = branchId;
      lastFocus = focus;
      if (moved) this.pendingAsk.clear();
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
    this.pendingAsk.destroy();
  }

  protected onScroll(el: HTMLElement): void {
    this.pinned.set(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  }

  protected async askAbout(q: MessageQuote): Promise<void> {
    this.pendingAsk.clear();
    window.getSelection()?.removeAllRanges();
    await this.store.askAbout(q.nodeId, q.quote);
  }

  protected async setModel(branchId: string, model: string): Promise<void> {
    this.switching.set(true);
    try {
      await this.store.setModel(branchId, model);
    } finally {
      this.switching.set(false);
    }
  }

  protected chooseFunding(option: FundingOption): void {
    this.account.payment.choose(option);
    this.store.dismissPoolBlock();
    if (option === 'pool') void this.account.switchToPool();
    else void this.account.refreshBalance();
  }

  protected exportLesson(): void {
    const d = this.store.detail();
    if (d) void this.store.exportLesson(d.tree.id);
  }

  protected deleteLesson(): void {
    const d = this.store.detail();
    if (!d) return;
    if (!confirm(`Delete the lesson “${lessonTitle(d.tree.title)}” with all its side questions?`))
      return;
    void this.store.deleteLesson(d.tree.id);
  }

  /** The open side question, with every side question below it (the lesson stays). */
  protected deleteSideQuestion(branchId: string): void {
    void confirmDeleteSideQuestion(this.store, branchId);
  }

  protected send(content: string): void {
    const id = this.store.selectedBranchId();
    if (!id) return;
    this.pinned.set(true);
    if (this.store.focusedNodeId()) this.store.go(id, null, true);
    void this.store.send(id, content);
  }

  protected stop(): void {
    const n = this.store.streamingNode();
    if (n) void this.store.cancel(n.id);
  }

  /** The document selection, when it lies inside one message of this lesson that isn't being written. */
  private selectedQuote(): MessageQuote | null {
    const found = selectedMessageQuote(this.scroller()?.nativeElement, window.getSelection());
    const node = found ? this.store.index()?.nodes.get(found.nodeId) : undefined;
    return node && node.status !== 'streaming' ? found : null;
  }

  private scrollTo(nodeId: string | null): void {
    const el = this.scroller()?.nativeElement;
    if (!el) return;
    if (nodeId) {
      document
        .getElementById(`msg-${nodeId}`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }
}
