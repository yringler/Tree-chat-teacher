/** Asks before deleting a lesson (`title` as the learner sees it), from the home page or the sidebar. */
export function confirmDeleteLesson(title: string): boolean {
  return confirm(`Delete the lesson “${title}” with all its side questions?`);
}
