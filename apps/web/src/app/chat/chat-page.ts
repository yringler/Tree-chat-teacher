import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import type { Branch, ChatNode, MembershipInfo } from '@tangent/shared';
import { ReadOnlyComposer } from '@tangent/web-shared';
import { Inspector } from '../inspector/inspector';
import { TextSizeStore } from '../state/text-size-store';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { ModeBadge } from '../ui/mode-badge';
import { ChatHeader } from './chat-header';
import { Composer } from './composer';
import { MessageItem } from './message-item';

interface Entry {
  node: ChatNode;
  ancestor: boolean;
  /** Set on the first message of each branch after the trunk: the branch it starts. */
  divider: Branch | null;
}

/** `/t/:treeId[/b/:branchId]`: linear view of the selected branch path. */
@Component({
  selector: 'app-chat-page',
  imports: [ChatHeader, Composer, MessageItem, ModeBadge, Inspector, ReadOnlyComposer, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './chat-page.html',
  host: { class: 'page chat-page' },
})
export class ChatPage {
  protected readonly store = inject(TreeStore);
  protected readonly ui = inject(UiStore);
  /** The user's text size for the messages and composer (see chat.css). */
  protected readonly textSize = inject(TextSizeStore);
  private readonly title = inject(Title);
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  /** True while the view is scrolled to (near) the bottom: new text keeps it pinned. */
  private readonly pinned = signal(true);

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

  protected readonly placeholder = computed(() => {
    const b = this.store.selectedBranch();
    if (!b) return 'Message…';
    if (this.store.path().length === 0) return 'Start the conversation…';
    if (!b.parentBranchId) return 'Reply…';
    // Default titles run to 50+ characters; a placeholder has one line.
    const title = b.title.length > 32 ? `${b.title.slice(0, 31).trimEnd()}…` : b.title;
    return `Reply in “${title}”…`;
  });

  /**
   * The selected branch is read-only (its funding needs the membership the
   * user lacks): what the notice standing in for the composer needs.
   */
  protected readonly readOnly = computed<{ membership: MembershipInfo; treeId: string } | null>(
    () => {
      const membership = this.store.membership();
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

  protected onScroll(el: HTMLElement): void {
    this.pinned.set(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  }

  protected send(content: string): void {
    const id = this.store.selectedBranchId();
    if (!id) return;
    this.pinned.set(true);
    if (this.store.focusedNodeId()) this.store.focus(null);
    void this.store.send(id, content);
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
