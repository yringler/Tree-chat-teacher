import { inject, Injectable } from '@angular/core';
import {
  ComposerController,
  dispatchShortcut,
  pathKeys,
  ThreadEnds,
  type ShortcutHelp,
} from '@tangent/web-shared';
import { LessonStore } from '../state/lesson-store';
import { UiStore } from '../state/ui-store';

export const SHORTCUTS: readonly ShortcutHelp[] = [
  { keys: ['Alt+↑', '['], label: 'Back to where this tangent started' },
  { keys: ['Alt+←', 'Alt+→'], label: 'Previous / next tangent beside this one' },
  { keys: ['Alt+↓', ']'], label: 'Into the first tangent from here' },
  { keys: ['j', 'k'], label: 'Next / previous message' },
  { keys: ['Home', 'End'], label: 'Start / end of the thread' },
  { keys: ['/'], label: 'Focus the message box' },
  { keys: ['Enter'], label: 'Send as a tangent' },
  { keys: ['Ctrl+Enter'], label: 'Send as Next' },
  { keys: ['?'], label: 'Show this help' },
  { keys: ['Esc'], label: 'Close dialogs and menus' },
];

/** Learn's shortcuts (`dispatchShortcut`: not while typing, nor behind a dialog). */
@Injectable({ providedIn: 'root' })
export class Keyboard {
  private readonly store = inject(LessonStore);
  private readonly ui = inject(UiStore);
  private readonly composer = inject(ComposerController);
  private readonly threadEnds = inject(ThreadEnds);

  private readonly keys: Readonly<Record<string, () => unknown>> = {
    ...pathKeys(this.store),
    // Taken only with a thread on screen; the start is the open tangent's.
    Home: () => this.threadEnds.toStart(),
    End: () => this.threadEnds.toEnd(),
    '/': () => this.composer.focus(),
  };

  handle(e: KeyboardEvent): void {
    dispatchShortcut(e, {
      closeTop: () => this.ui.closeTop(),
      dialogOpen: () => this.ui.dialogs.anyOpen(),
      toggleHelp: () => this.ui.dialogs.toggle({ kind: 'shortcuts' }),
      navigate: (step) => this.store.navigate(step),
      keys: this.keys,
    });
  }
}
