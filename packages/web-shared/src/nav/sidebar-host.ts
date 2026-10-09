import { Injectable, signal } from '@angular/core';
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
  /** What a branch is called: "branch", "side question". */
  branch: string;
  /** The outline's accessible name: "Branches", "Side questions". */
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
  /** Branches can be renamed in place (double-click or the pencil). */
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

/** The sidebar's view state, outside the URL. */
@Injectable({ providedIn: 'root' })
export class SidebarState {
  /** Narrow screens: the sidebar is a drawer, open over the page. */
  readonly drawerOpen = signal(false);
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
}
