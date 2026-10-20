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
import { clip, COMPOSER_PLACEHOLDERS, type MembershipInfo } from '@tangent/shared';
import { describeEndpoint } from '@tangent/core';
import {
  Composer,
  ComposerController,
  ComposerQuote,
  ComposerTarget,
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
  /** Where the conversation is scrolled. */
  protected readonly thread = new ThreadScroll({
    store: this.store,
    scroller: () => this.scroller()?.nativeElement,
    moved: () => {
      this.selection.clear();
      this.composer.drop();
    },
  });

  /** Where the message box sends, by the rule Learn's follows too (`ComposerTarget`). */
  protected readonly box = new ComposerTarget({ store: this.store, thread: this.thread });

  /**
   * Tangent ↳ and Next ➜ in place of Send, once there is a reply to go on a
   * tangent from; Tangent ↳'s caret opens Tangent from here.
   */
  protected readonly actions = computed(() =>
    sendActions(this.box.plan().actions, { tangent: TANGENT_OPTIONS }),
  );

  protected readonly placeholder = computed(() => {
    if (!this.store.selectedBranch()) return 'Message…';
    const place = this.box.plan().place;
    return place === 'start' ? 'Start the conversation…' : COMPOSER_PLACEHOLDERS[place];
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
    () =>
      !this.store.busy() && !this.box.lead() && this.tiers.available(this.store.selectedBranch()),
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

  /**
   * "Ask about this": the selection on the message box, focused, as a
   * message's Tangent ↳ and `b` put it (`TreeStore.aimComposer`, which opens
   * Tangent from here on a read-only thread); the tangent is made when the
   * box's message is sent.
   */
  protected askAbout(q: MessageQuote): void {
    this.selection.clear();
    window.getSelection()?.removeAllRanges();
    this.store.aimComposer(q);
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
    if (id === 'tangent') void this.box.goOnTangent(text);
    else this.box.send(text);
  }

  /**
   * Tangent ↳'s caret (or Ctrl/Cmd+Shift+Enter): Tangent from here, from the
   * composer's target, with the lead's quote and what is typed as its
   * starting message. The box lets the text go once the dialog has made
   * the tangent, edited there or not; cancelling leaves the box as it was.
   */
  protected tangentWithOptions(text: string): void {
    const from = this.box.plan().target;
    if (!from) return;
    this.ui.dialogs.open({
      kind: 'branch',
      fromNodeId: from,
      quote: this.box.lead()?.quote ?? null,
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
