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
import type { Branch, ChatNode } from '@tangent/shared';
import { Icon } from '@tangent/web-shared';
import { BRAND } from '../brand';
import { LessonStore } from '../state/lesson-store';
import { Composer } from './composer';
import { MessageItem } from './message-item';
import { ModelToggle } from './model-toggle';
import { branchTitle, lessonTitle } from './titles';

interface Entry {
  node: ChatNode;
  ancestor: boolean;
  /** Set on the first message of each side question: the branch it starts. */
  divider: Branch | null;
}

interface PendingAsk {
  nodeId: string;
  quote: string;
}

const MAX_QUOTE = 10_000;

/** `/t/:treeId[/b/:branchId]`: the lesson, one branch at a time. */
@Component({
  selector: 'app-chat-page',
  imports: [Composer, MessageItem, ModelToggle, Icon, RouterLink, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './chat-page.html',
  host: {
    class: 'page chat-page',
    '(document:selectionchange)': 'onSelectionChange()',
  },
})
export class ChatPage implements OnDestroy {
  protected readonly store = inject(LessonStore);
  private readonly title = inject(Title);
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  /** True while the view is scrolled to (near) the bottom: new text keeps it pinned. */
  private readonly pinned = signal(true);
  protected readonly switching = signal(false);
  /** Text selected inside one message: offers "Ask about this". */
  protected readonly pendingAsk = signal<PendingAsk | null>(null);
  private clearAskTimer: ReturnType<typeof setTimeout> | undefined;

  protected readonly branchTitle = branchTitle;
  /** The lesson's title in the learner's words ("New lesson" until the first reply names it). */
  protected readonly lessonTitle = computed(() => {
    const t = this.store.detail()?.tree.title;
    return t === undefined ? '' : lessonTitle(t);
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

  protected readonly placeholder = computed(() => {
    const b = this.store.selectedBranch();
    if (!b || this.store.path().length === 0) return 'What do you want to learn?';
    if (b.parentBranchId && this.emptyBranch()) return 'Ask your side question…';
    return 'Reply…';
  });

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
      if (moved) this.pendingAsk.set(null);
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
    clearTimeout(this.clearAskTimer);
  }

  protected onScroll(el: HTMLElement): void {
    this.pinned.set(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  }

  /** Maps the document selection to one finished message of this lesson, if it lies inside one. */
  protected onSelectionChange(): void {
    const found = this.selectedQuote();
    clearTimeout(this.clearAskTimer);
    if (found) {
      this.pendingAsk.set(found);
      return;
    }
    // Hide a little later: a tap on the button may collapse the selection first.
    if (this.pendingAsk()) this.clearAskTimer = setTimeout(() => this.pendingAsk.set(null), 400);
  }

  protected async askAbout(nodeId: string, quote: string): Promise<void> {
    this.pendingAsk.set(null);
    window.getSelection()?.removeAllRanges();
    await this.store.askAbout(nodeId, quote);
  }

  protected async setModel(branchId: string, model: string): Promise<void> {
    this.switching.set(true);
    try {
      await this.store.setModel(branchId, model);
    } finally {
      this.switching.set(false);
    }
  }

  protected deleteLesson(): void {
    const d = this.store.detail();
    if (!d) return;
    if (!confirm(`Delete the lesson “${lessonTitle(d.tree.title)}” with all its side questions?`))
      return;
    void this.store.deleteLesson(d.tree.id);
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

  private selectedQuote(): PendingAsk | null {
    const container = this.scroller()?.nativeElement;
    const sel = window.getSelection();
    if (!container || !sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const common = sel.getRangeAt(0).commonAncestorContainer;
    if (!container.contains(common)) return null;
    const el = (common instanceof Element ? common : common.parentElement)?.closest<HTMLElement>(
      '[data-node-id]',
    );
    const nodeId = el?.dataset['nodeId'];
    const node = nodeId ? this.store.index()?.nodes.get(nodeId) : undefined;
    if (!node || node.status === 'streaming') return null;
    const quote = sel.toString().trim().slice(0, MAX_QUOTE);
    return quote ? { nodeId: node.id, quote } : null;
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
