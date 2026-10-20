import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  type OnDestroy,
  viewChild,
} from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import {
  clip,
  COMPOSER_PLACEHOLDERS,
  composerExcerpt,
  composerPlan,
  type MembershipInfo,
} from '@tangent/shared';
import { describeEndpoint } from '@tangent/core';
import {
  Composer,
  ComposerController,
  ComposerQuote,
  endpointTitle,
  Icon,
  JumpToEnd,
  PendingQuote,
  ReadOnlyComposer,
  selectedMessageQuote,
  SelectionAsk,
  sendActions,
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

/** What Tangent ↳'s caret opens: Tangent from here, set up before the tangent starts. */
const TANGENT_OPTIONS = 'Tangent with options: context, model, quote…';

/** `/t/:treeId[/b/:branchId]`: linear view of the selected branch path. */
@Component({
  selector: 'app-chat-page',
  imports: [
    ChatHeader,
    Composer,
    ComposerQuote,
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
  private readonly composer = inject(ComposerController);
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  /**
   * Text selected in a finished message: offers "Ask about this" (the words
   * on the composer, asked about in a `path` tangent made when the message
   * is sent; Tangent ↳'s caret there sets that tangent up first).
   */
  protected readonly selection = new PendingQuote(() => this.quoteToAsk());
  /**
   * What the composer's next message asks about, in a new tangent: words
   * "Ask about this" quoted, or a whole message (its Tangent ↳, `b`).
   */
  protected readonly lead = this.composer.lead;
  /** Where the conversation is scrolled. */
  protected readonly thread = new ThreadScroll({
    store: this.store,
    scroller: () => this.scroller()?.nativeElement,
    moved: () => {
      this.selection.clear();
      this.composer.drop();
    },
  });

  /**
   * What the composer offers and where its tangent starts: the message it is
   * aimed at, else the focused reply of the open thread, else its last reply
   * (`composerPlan`, as in Learn).
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

  /**
   * Tangent ↳ and Next ➜ in place of Send, once there is a reply to go on a
   * tangent from; Tangent ↳'s caret opens Tangent from here.
   */
  protected readonly actions = computed(() =>
    sendActions(this.plan().actions, { tangent: TANGENT_OPTIONS }),
  );

  protected readonly placeholder = computed(() => {
    if (!this.store.selectedBranch()) return 'Message…';
    const place = this.plan().place;
    return place === 'start' ? 'Start the conversation…' : COMPOSER_PLACEHOLDERS[place];
  });

  /**
   * The opening words of the reply the composer's tangent starts at, for the
   * open box to name when it may not be the one in view; a lead names itself.
   */
  protected readonly target = computed(() => {
    const target = this.plan().target;
    return target && !this.lead() ? this.excerptOf(target) : null;
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

  /**
   * Compare is offered: Normal and Max are two models the open branch can
   * use, it is idle, and the message continues it (not a lead's new tangent).
   */
  protected readonly canCompare = computed(
    () => !this.store.busy() && !this.lead() && this.tiers.available(this.store.selectedBranch()),
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

    this.composer.holdLead((nodeId) => this.store.index()?.nodes.has(nodeId) ?? false);
  }

  ngOnDestroy(): void {
    this.selection.destroy();
  }

  /** "Ask about this": the selection on the composer, focused; the tangent is made when it is sent. */
  protected askAbout(q: MessageQuote): void {
    if (this.selectionLocked()) {
      this.moreAbout(q);
      return;
    }
    this.selection.clear();
    window.getSelection()?.removeAllRanges();
    this.composer.aim(q);
  }

  /** The opening words of message `nodeId`, for the composer to say what it asks about. */
  protected excerptOf(nodeId: string): string {
    return composerExcerpt(this.store.index()?.nodes.get(nodeId)?.content ?? '');
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

  /**
   * Words of a message on a route that needs the membership: Tangent from
   * here with the quote filled in, where a route that can reply is picked.
   */
  private moreAbout(q: MessageQuote): void {
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

  /** Tangent ↳ or Next ➜ pressed (or Enter / Ctrl+Enter) with the composer's text. */
  protected act({ id, text }: { id: string; text: string }): void {
    if (id === 'tangent') void this.goOnTangent(text);
    else this.send(text);
  }

  /** The message continues what is open (Send or Next ➜). */
  protected send(content: string): void {
    const id = this.store.selectedBranchId();
    if (!id) return;
    this.thread.pin();
    if (this.store.focusedNodeId()) this.store.focus(null);
    void this.store.send(id, content);
  }

  /**
   * The message starts a `path` tangent from the composer's target, quoting
   * the lead's words if any; the lead stays on the box if the tangent can't
   * be made.
   */
  private async goOnTangent(content: string): Promise<void> {
    const from = this.plan().target;
    if (!from) return;
    this.thread.pin();
    if (await this.store.askFrom(from, content, this.lead()?.quote ?? null)) this.composer.drop();
  }

  /**
   * Tangent ↳'s caret (or Ctrl/Cmd+Shift+Enter): Tangent from here, from the
   * composer's target, with the lead's quote and what is typed as its
   * starting message. The box lets the text go once that message reaches
   * the server (`ComposerController.sent`), unless it was changed there;
   * cancelling leaves the box as it was.
   */
  protected tangentWithOptions(text: string): void {
    const from = this.plan().target;
    if (!from) return;
    this.ui.dialogs.open({
      kind: 'branch',
      fromNodeId: from,
      quote: this.lead()?.quote ?? null,
      message: text,
    });
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
