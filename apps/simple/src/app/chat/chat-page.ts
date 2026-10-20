import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  type OnDestroy,
  untracked,
  viewChild,
} from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { describeEndpoint } from '@tangent/core/links';
import {
  COMPOSER_PLACEHOLDERS,
  composerPlan,
  MAIN_THREAD_BACK,
  MAIN_THREAD_LABEL,
  plainText,
  splitTangents,
  THREAD_ENDS,
  type ChatNode,
} from '@tangent/shared';
import {
  Composer,
  ComposerController,
  ComposerQuote,
  Icon,
  JumpToEnd,
  PendingQuote,
  pointerHovers,
  PoolBlockNotice,
  Segmented,
  selectedMessageQuote,
  SelectionAsk,
  sendActions,
  TextSizeMenu,
  TextSizeStore,
  ThreadScroll,
  Walkthrough,
  type MessageQuote,
} from '@tangent/web-shared';
import { BRAND } from '../brand';
import { LessonStore } from '../state/lesson-store';
import { UiStore } from '../state/ui-store';
import { connectionTitleOf } from './connections';
import { KeyLockedNotice } from './key-locked-notice';
import { MessageItem } from './message-item';
import { FUNDING_OPTIONS, ownKeyOption, type FundingOption } from './switches';
import { branchTitle, lessonTitle } from './titles';
import { LearnFunding } from '../state/learn-funding';

/** How much of a whole message the composer shows when its message asks about it. */
const EXCERPT_CHARS = 60;

/** `/t/:treeId[/b/:branchId]`: the lesson, one branch at a time. */
@Component({
  selector: 'app-chat-page',
  imports: [
    Composer,
    ComposerQuote,
    MessageItem,
    Segmented,
    Icon,
    JumpToEnd,
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
  /** The first crumb: the lesson's trunk, the way back from any tangent. */
  protected readonly mainThreadLabel = MAIN_THREAD_LABEL;
  protected readonly mainThreadBack = MAIN_THREAD_BACK;
  protected readonly threadEnds = THREAD_ENDS;
  /** Text selected inside one finished message: offers "Ask about this". */
  protected readonly pendingAsk = new PendingQuote(() => this.selectedQuote());
  /**
   * What the composer's next message asks about, on a tangent made when it is
   * sent: words "Ask about this" quoted, or a whole message (its Tangent ↳, `b`).
   */
  protected readonly lead = this.composer.lead;
  /** Where the lesson is scrolled; a reply being written is read from its first line. */
  protected readonly thread = new ThreadScroll({
    store: this.store,
    scroller: () => this.scroller()?.nativeElement,
    readRepliesFromStart: true,
    moved: () => {
      this.pendingAsk.clear();
      this.composer.drop();
    },
  });

  /** A coach mark of the first-run walkthrough is showing. */
  protected readonly coachShowing = computed(() => this.walkthrough.current() !== null);

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
   * What the composer offers and where its tangent starts: the reply it is
   * aimed at, else the focused reply of the open thread, else its last reply
   * (`composerPlan`).
   */
  protected readonly plan = computed(() =>
    composerPlan({
      path: this.store.path(),
      branchId: this.store.selectedBranchId(),
      inTangent: this.store.selectedBranch()?.parentBranchId != null,
      focusedId: this.store.focusedInPath()?.id ?? null,
      lead: this.lead(),
    }),
  );

  /** Tangent ↳ and Next ➜ in place of Send, once there is a reply to go on a tangent from. */
  protected readonly actions = computed(() => sendActions(this.plan().actions, pointerHovers()));

  protected readonly placeholder = computed(() => {
    const place = this.plan().place;
    return place === 'start' ? 'What do you want to learn?' : COMPOSER_PLACEHOLDERS[place];
  });

  /**
   * The opening words of the reply the composer's tangent starts at, for the
   * open box to name when it may not be the one in view; a lead names itself.
   */
  protected readonly target = computed(() => {
    const target = this.plan().target;
    return target && !this.lead() ? this.excerptOf(target) : null;
  });

  /** The pool's refusal of a message in this branch (empty or a cap), shown above the composer. */
  protected readonly poolBlock = computed(() => {
    const block = this.store.poolBlock();
    return block && block.branchId === this.store.selectedBranchId() ? block : null;
  });

  /** The funding switch's stop: what replies run on. */
  protected readonly fundingOption = computed<FundingOption>(() => this.funding.payer());

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

    // A message deleted from under the composer takes the lead with it: the
    // box can't ask about a message that isn't there.
    effect(() => {
      const lead = this.lead();
      if (lead && !this.store.index()?.nodes.has(lead.nodeId)) {
        untracked(() => this.composer.drop());
      }
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
        this.plan().actions.length > 1 && !this.store.busy() && !this.funding.membershipBlocked();
      untracked(() => {
        if (inTangent) this.walkthrough.onEnteredTangent();
        else if (actionsShown) {
          this.walkthrough.onTrunkReplyReady();
          this.walkthrough.onBackOnTrunk();
        }
      });
    });
  }

  ngOnDestroy(): void {
    this.pendingAsk.destroy();
    this.composer.drop();
  }

  /** Puts the selected words on the composer; the tangent is made when it is sent. */
  protected askAbout(q: MessageQuote): void {
    this.pendingAsk.clear();
    window.getSelection()?.removeAllRanges();
    this.composer.aim(q);
  }

  /** A message's own Tangent ↳: the message goes on the composer, the tangent is made when it is sent. */
  protected askAboutMessage(node: ChatNode): void {
    this.pendingAsk.clear();
    this.composer.aim({ nodeId: node.id, quote: null });
  }

  /** The opening words of message `nodeId`, for the composer to say what it asks about. */
  protected excerptOf(nodeId: string): string {
    const content = this.store.index()?.nodes.get(nodeId)?.content ?? '';
    return plainText(splitTangents(content).body, { max: EXCERPT_CHARS });
  }

  protected dropLead(): void {
    this.composer.drop();
    this.composer.focus();
  }

  /** The named target clicked: that reply comes into view. */
  protected showTarget(): void {
    const target = this.plan().target;
    if (target) this.thread.toMessage(target);
  }

  /** Credit and the pool, and the own key ("Anthropic key") while it could reply. */
  protected readonly fundingOptions = computed(() =>
    this.funding.fundingKeyStop()
      ? [...FUNDING_OPTIONS, ownKeyOption(this.funding.ownKeyLabel())]
      : FUNDING_OPTIONS,
  );

  protected chooseFunding(id: string): void {
    const option = this.fundingOptions().find((o) => o.id === id)?.id;
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
    this.thread.pin();
    if (this.store.focusedNodeId()) this.store.go(id, null, true);
    void this.store.send(id, content);
  }

  /** The message starts a tangent from the composer's target, about the words on it if any. */
  private async goOnTangent(content: string): Promise<void> {
    const from = this.plan().target;
    if (!from) return;
    this.thread.pin();
    // Kept on failure, to try again.
    if (await this.store.askFrom(from, content, this.lead()?.quote ?? null)) this.composer.drop();
  }

  /** The lesson's own instructions, offered only where the learner pays (the pool ignores them). */
  protected openInstructions(): void {
    this.ui.dialogs.open({ kind: 'instructions' });
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
}
