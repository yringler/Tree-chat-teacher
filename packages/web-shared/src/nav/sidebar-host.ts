import { inject, Injectable, InjectionToken, type Provider, signal } from '@angular/core';
import type { OutlineItem } from '@tangent/core/tree';
import type { TreeSummary } from '@tangent/shared';
import type { ConversationStore } from '../conversation/conversation-store';

/** The sidebar's words in the app's terms. */
export interface SidebarWords {
  /** The button that starts one: "New conversation", "New lesson". */
  newTree: string;
  /** The list's accessible name: "Conversations", "Lessons". */
  trees: string;
  /** Shown while there are none. */
  noTrees: string;
  /** What one is called: "conversation", "lesson". */
  tree: string;
  /** What a branch is called: "tangent". */
  branch: string;
  /** The outline's accessible name: "Tangents". */
  branches: string;
}

/**
 * What an app tells the shared sidebar (`ConversationSidebar`): its store,
 * its words, and what opening, renaming and deleting do there. The app's
 * sidebar component provides itself as this.
 */
export abstract class SidebarHost {
  abstract readonly store: ConversationStore;
  abstract readonly words: SidebarWords;
  /** Tangents can be renamed in place (double-click or the pencil); the main thread can't. */
  abstract readonly canRename: boolean;
  abstract treeTitle(title: string): string;
  abstract branchTitle(item: OutlineItem): string;
  /** The count beside a listed conversation, and its tooltip. */
  abstract treeCount(tree: TreeSummary): { text: string; title: string };
  /** Asks, then deletes the conversation. */
  abstract deleteTree(treeId: string, title: string): void;
  /** Asks, then deletes the branch with everything below it. */
  abstract deleteBranch(branchId: string): void;
  abstract openBranch(item: OutlineItem): void;
}

/**
 * The localStorage key an app keeps "sidebar hidden" under, so hiding it in
 * Canvas, where the map wants the width, leaves power's and Learn's alone.
 * Power uses the default; the other apps provide theirs with `provideSidebar`.
 */
export const SIDEBAR_HIDDEN_KEY = new InjectionToken<string>('SIDEBAR_HIDDEN_KEY');

/** Provides the app's "sidebar hidden" key (see SIDEBAR_HIDDEN_KEY). */
export function provideSidebar(hiddenKey: string): Provider {
  return { provide: SIDEBAR_HIDDEN_KEY, useValue: hiddenKey };
}

/** The sidebar's view state, outside the URL. */
@Injectable({ providedIn: 'root' })
export class SidebarState {
  private readonly hiddenKey =
    inject(SIDEBAR_HIDDEN_KEY, { optional: true }) ?? 'tangent.sidebarHidden';
  /** Narrow screens: the sidebar is a drawer, open over the page. */
  readonly drawerOpen = signal(false);
  /**
   * Wide screens: the user hid the sidebar to give the page its width. Kept in
   * this browser; narrow screens ignore it, since there the sidebar is a drawer.
   */
  readonly hidden = signal(this.readHidden());
  /** Outline items the user collapsed (by branch id). */
  readonly collapsed = signal<ReadonlySet<string>>(new Set());

  toggleCollapsed(branchId: string): void {
    this.collapsed.update((set) => {
      const next = new Set(set);
      if (next.has(branchId)) next.delete(branchId);
      else next.add(branchId);
      return next;
    });
  }

  toggleHidden(): void {
    const hidden = !this.hidden();
    this.hidden.set(hidden);
    try {
      if (hidden) localStorage.setItem(this.hiddenKey, '1');
      else localStorage.removeItem(this.hiddenKey);
    } catch {
      // Storage unavailable (private mode, blocked): keep the in-memory value.
    }
  }

  private readHidden(): boolean {
    try {
      return localStorage.getItem(this.hiddenKey) === '1';
    } catch {
      return false;
    }
  }
}
