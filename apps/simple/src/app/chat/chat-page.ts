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
import {
  MAIN_THREAD_BACK,
  MAIN_THREAD_LABEL,
  REPLY_ACTION,
  TANGENT_ACTION,
  type ChatNode,
} from '@tangent/shared';
import {
  Composer,
  ComposerController,
  Icon,
  PendingQuote,
  PoolBlockNotice,
  Segmented,
  selectedMessageQuote,
  SelectionAsk,
  TextSizeMenu,
  TextSizeStore,
  Walkthrough,
  type ComposerAction,
  type MessageQuote,
} from '@tangent/web-shared';
import { BRAND } from '../brand';
import { LessonStore } from '../state/lesson-store';
import { UiStore } from '../state/ui-store';
import { connectionTitleOf } from './connections';
import { KeyLockedNotice } from './key-locked-notice';
import { MessageItem } from './message-item';
import { FUNDING_OPTIONS, type FundingOption } from './switches';
import { branchTitle, lessonTitle } from './titles';
import { LearnFunding } from '../state/learn-funding';

/** `/t/:treeId[/b/:branchId]`: the lesson, one branch at a time. */
@Component({
  selector: 'app-chat-page',
  imports: [
    Composer,
    MessageItem,
    Segmented,
    Icon,
    PoolBlockNotice,
    RouterLink,
    NgTemplateOutlet,
    SelectionAsk,
    TextSizeMenu,
    KeyLockedNotice,
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
  protected readonly funding = inject(LearnFunding);
  protected readonly textSize = inject(TextSizeStore);
  private readonly ui = inject(UiStore);
  private readonly composer = inject(ComposerController);
  private readonly title = inject(Title);
  private readonly walkthrough = inject(Walkthrough);
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  /** True while the view is scrolled to (near) the bottom: new text keeps it pinned. */
  private readonly pinned = signal(true);
  /** The first crumb: the lesson's trunk, the way back from any tangent. */
  protected readonly mainThreadLabel = MAIN_THREAD_LABEL;
  protected readonly mainThreadBack = MAIN_THREAD_BACK;
  /** Text selected inside one finished message: offers "Ask about this". */
  protected readonly pendingAsk = new PendingQuote(() => this.selectedQuote());
  /** Words "Ask about this" put on the composer: the next message asks about them. */
  protected readonly quote = signal<MessageQuote | null>(null);

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

  /**
   * The reply a tangent from the composer starts at: the last message on
   * screen, once it is a reply that didn't fail. Otherwise (a new lesson, an
   * empty tangent, a failed reply) the message continues what is open, with
   * nothing to choose.
   */
  protected readonly asideFrom = computed<ChatNode | null>(() => {
    const last = this.store.emptyBranch() ? undefined : this.store.path().at(-1);
    return last?.role === 'assistant' && last.status !== 'error' ? last : null;
  });

  /**
   * The composer's buttons in place of Send, once there is a reply to go on
   * a tangent from: Tangent ↳ first (Enter), since a needless tangent costs
   * nothing and a stray reply clutters the lesson for good, then Next ➜
   * (Ctrl+Enter). Words to ask about only go on a tangent.
   */
  protected readonly actions = computed<readonly ComposerAction[]>(() => {
    const tangent: ComposerAction = {
      id: 'tangent',
      label: TANGENT_ACTION.label,
      title: `${TANGENT_ACTION.hint} (Enter)`,
      primary: true,
    };
    if (this.quote()) return [tangent];
    if (!this.asideFrom()) return [];
    const inTangent = this.store.selectedBranch()?.parentBranchId != null;
    const hint = inTangent ? REPLY_ACTION.hintInTangent : REPLY_ACTION.hint;
    return [
      tangent,
      { id: 'next', label: REPLY_ACTION.label, title: `${hint} (Ctrl+Enter)`, primary: false },
    ];
  });

  protected readonly placeholder = computed(() => {
    const b = this.store.selectedBranch();
    if (!b || this.store.path().length === 0) return 'What do you want to learn?';
    if (b.parentBranchId && this.store.emptyBranch()) return 'Ask your tangent…';
    if (this.quote()) return 'Ask about this…';
    return b.parentBranchId ? 'Ask anything in this tangent…' : 'Ask anything…';
  });

  /** The pool's refusal of a message in this branch (empty or a cap), shown above the composer. */
  protected readonly poolBlock = computed(() => {
    const block = this.store.poolBlock();
    return block && block.branchId === this.store.selectedBranchId() ? block : null;
  });

  protected readonly fundingOption = computed<FundingOption>(() =>
    this.funding.payer() === 'pool' ? 'pool' : 'credit',
  );

  /**
   * A message refused before it reached the lesson (no credit, the pool, a
   * missing key…), offered back in its branch, also after a top-up or the
   * human check (kept for the tab).
   */
  protected readonly initialDraft = this.store.composerDraft;

  constructor() {
    effect(() => {
      const t = this.lessonTitle();
      this.title.setTitle(t ? `${t} · ${BRAND}` : BRAND);
    });

    // Tells the first-run walkthrough where the learner is: on the main thread
    // with Tangent ↳ and Next ➜ under a reply, or inside a tangent. Again when
    // its coach mark changes or a dialog closes (a replay, from the help), so
    // a step waiting for this screen finds it.
    const coachStep = computed(() => this.walkthrough.current()?.step ?? null);
    effect(() => {
      coachStep();
      this.ui.dialogs.list();
      const b = this.store.selectedBranch();
      if (!b) return;
      const inTangent = b.parentBranchId !== null;
      const actionsShown =
        this.actions().length > 1 &&
        this.asideFrom()?.status === 'complete' &&
        !this.funding.membershipBlocked();
      untracked(() => {
        if (inTangent) this.walkthrough.onEnteredTangent();
        else if (actionsShown) {
          this.walkthrough.onTrunkReplyReady();
          this.walkthrough.onBackOnTrunk();
        }
      });
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
      if (moved) {
        this.pendingAsk.clear();
        this.quote.set(null);
      }
      if (moved || untracked(this.pinned)) {
        if (moved && !focus) this.pinned.set(true);
        requestAnimationFrame(() => this.scrollTo(moved ? focus : null));
      }
    });

    // Follow a reply while it streams in, while the view is pinned.
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

  /** Puts the selected words on the composer; the tangent is made when it is sent. */
  protected askAbout(q: MessageQuote): void {
    this.pendingAsk.clear();
    window.getSelection()?.removeAllRanges();
    this.quote.set(q);
    this.composer.focus();
  }

  protected dropQuote(): void {
    this.quote.set(null);
    this.composer.focus();
  }

  protected readonly fundingOptions = FUNDING_OPTIONS;

  protected chooseFunding(id: string): void {
    const option = FUNDING_OPTIONS.find((o) => o.id === id)?.id;
    if (!option) return;
    this.funding.switchTo(option);
  }

  protected exportLesson(): void {
    const d = this.store.detail();
    if (d) void this.store.exportLesson(d.tree.id);
  }

  protected deleteLesson(): void {
    const d = this.store.detail();
    if (!d) return;
    if (!confirm(`Delete the lesson “${lessonTitle(d.tree.title)}” with all its tangents?`)) return;
    void this.store.deleteTree(d.tree.id);
  }

  /** Tangent ↳ or Next ➜ pressed (or Enter / Ctrl+Enter) with the composer's text. */
  protected act({ id, text }: { id: string; text: string }): void {
    if (id === 'tangent') {
      void this.goOnTangent(text);
      return;
    }
    if (this.store.selectedBranch()?.parentBranchId === null) this.walkthrough.onRepliedOnTrunk();
    this.send(text);
  }

  /** The message continues what is open (Send or Next ➜). */
  protected send(content: string): void {
    const id = this.store.selectedBranchId();
    if (!id) return;
    this.pinned.set(true);
    if (this.store.focusedNodeId()) this.store.go(id, null, true);
    void this.store.send(id, content);
  }

  /** The message starts a tangent from the quoted reply, or else the last one. */
  private async goOnTangent(content: string): Promise<void> {
    const from = this.tangentFrom();
    if (!from) return;
    this.pinned.set(true);
    // Kept on failure, to try again.
    if (await this.store.askFrom(from, content, this.quote()?.quote ?? null)) this.quote.set(null);
  }

  /** The lesson's own instructions, offered only where the learner pays (the pool ignores them). */
  protected openInstructions(): void {
    this.ui.dialogs.open({ kind: 'instructions' });
  }

  /** The message a tangent from the composer starts at; null: there is none to go on. */
  private tangentFrom(): string | null {
    return this.quote()?.nodeId ?? this.asideFrom()?.id ?? null;
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
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else {
      this.followEnd(el);
    }
  }

  /**
   * Scrolls to the bottom, but a reply being written only until its start
   * reaches the top of the view, so the learner reads it from its first line;
   * past that, the end grows out of sight. A learner who scrolls on below its
   * start is followed again.
   */
  private followEnd(el: HTMLElement): void {
    const reply = this.store.streamingNode();
    const host = reply ? document.getElementById(`msg-${reply.id}`) : null;
    if (host) {
      const top = el.scrollTop + host.getBoundingClientRect().top - el.getBoundingClientRect().top;
      if (el.scrollTop <= top && top < el.scrollHeight - el.clientHeight) {
        this.pinned.set(false);
        el.scrollTop = top;
        return;
      }
    }
    el.scrollTop = el.scrollHeight;
  }
}
