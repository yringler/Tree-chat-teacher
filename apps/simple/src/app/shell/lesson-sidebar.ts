import { ChangeDetectionStrategy, Component, forwardRef, inject } from '@angular/core';
import type { OutlineItem } from '@tangent/core/tree';
import type { TreeSummary } from '@tangent/shared';
import { ConversationSidebar, SidebarHost } from '@tangent/web-shared';
import { confirmDeleteSideQuestion } from '../chat/delete-side-question';
import { branchTitle, lessonTitle } from '../chat/titles';
import { LessonStore } from '../state/lesson-store';
import { confirmDeleteLesson } from './delete-lesson';

/**
 * Learn's sidebar: the shared conversation sidebar over the learner's
 * lessons, the open one's side questions nested under the one each came
 * from. A side question opens at its first message, as from its chip; the
 * lesson where it continues.
 */
@Component({
  selector: 'app-lesson-sidebar',
  imports: [ConversationSidebar],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [{ provide: SidebarHost, useExisting: forwardRef(() => LessonSidebar) }],
  template: `<app-conversation-sidebar />`,
  host: { style: 'display: contents' },
})
export class LessonSidebar extends SidebarHost {
  readonly store = inject(LessonStore);
  readonly words = {
    newTree: 'New lesson',
    trees: 'Lessons',
    noTrees: 'No lessons yet.',
    tree: 'lesson',
    branch: 'side question',
    branches: 'Side questions',
  };
  readonly canRename = false;

  treeTitle(title: string): string {
    return lessonTitle(title);
  }

  branchTitle(item: OutlineItem): string {
    return item.depth === 0 ? 'Lesson' : branchTitle(item.branch);
  }

  treeCount(t: TreeSummary): { text: string; title: string } {
    const side = t.branchCount - 1;
    const messages = `${t.messageCount} ${t.messageCount === 1 ? 'message' : 'messages'}`;
    return {
      text: String(t.messageCount),
      title:
        side > 0
          ? `${side} ${side === 1 ? 'side question' : 'side questions'}, ${messages}`
          : messages,
    };
  }

  deleteTree(treeId: string, title: string): void {
    if (!confirmDeleteLesson(title)) return;
    void this.store.deleteTree(treeId);
  }

  deleteBranch(branchId: string): void {
    void confirmDeleteSideQuestion(this.store, branchId);
  }

  openBranch(item: OutlineItem): void {
    if (item.depth === 0) this.store.go(item.branch.id);
    else this.store.openAtStart(item.branch.id);
  }
}
