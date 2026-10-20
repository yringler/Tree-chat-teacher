import { inject, Injectable } from '@angular/core';
import { replyToAim, type ComposerLead } from '@tangent/shared';
import {
  ComposerController,
  dispatchShortcut,
  pathKeys,
  selectedMessageQuote,
  ThreadEnds,
  TextSizeStore,
  type ShortcutHelp,
} from '@tangent/web-shared';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { selectionWithin } from './selection';

export const SHORTCUTS: readonly ShortcutHelp[] = [
  { keys: ['Alt+↑', '['], label: 'Parent thread (where this tangent started)' },
  { keys: ['Alt+←', 'Alt+→'], label: 'Previous / next tangent' },
  { keys: ['Alt+↓', ']'], label: 'First tangent from here' },
  { keys: ['j', 'k'], label: 'Next / previous message' },
  { keys: ['Home', 'End'], label: 'Start / end of the thread' },
  {
    keys: ['b'],
    label: 'Put the selected words, else the focused (or latest) reply, on the message box',
  },
  { keys: ['Shift+B'], label: 'Open Tangent from here for the focused (or latest) message' },
  { keys: ['v'], label: 'Review up to the focused (or latest) reply' },
  { keys: ['l'], label: 'Link the focused (or latest) message to another' },
  { keys: ['/'], label: 'Focus the composer' },
  { keys: ['i'], label: 'Toggle the context inspector' },
  { keys: ['+', '-'], label: 'Larger / smaller conversation text' },
  { keys: ['0'], label: 'Reset the conversation text size' },
  { keys: ['?'], label: 'Show this help' },
  { keys: ['Esc'], label: 'Close dialogs and panels, stop picking a message to link' },
];

/** Global shortcuts (`dispatchShortcut`: not while typing, nor behind a dialog). */
@Injectable({ providedIn: 'root' })
export class Keyboard {
  private readonly store = inject(TreeStore);
  private readonly ui = inject(UiStore);
  private readonly composer = inject(ComposerController);
  private readonly threadEnds = inject(ThreadEnds);
  private readonly textSize = inject(TextSizeStore);

  /** On an open conversation only. */
  private onTree(run: () => void): () => void {
    return () => {
      if (this.store.index() !== null) run();
    };
  }

  private readonly keys: Readonly<Record<string, () => unknown>> = {
    ...pathKeys(this.store),
    // Taken only with a thread on screen; the start is the open tangent's.
    Home: () => this.threadEnds.toStart(),
    End: () => this.threadEnds.toEnd(),
    // As a message's Tangent ↳: the next message asks about it in a new tangent.
    b: () => {
      // Nothing to branch onto without a route to generate on (power is read-only).
      if (!this.store.account.canGenerate()) return false;
      const lead = this.selectedWords() ?? this.replyLead();
      if (!lead) return false;
      // The words are on the box now: the selection's "Ask about this" would only offer them again.
      if (lead.quote) window.getSelection()?.removeAllRanges();
      this.store.aimComposer(lead);
      return true;
    },
    // Shift+B: the tangent's options first (context mode, route, quote).
    B: () => {
      const node = this.store.focusedInPath() ?? this.store.leaf();
      if (!node || !this.store.account.canGenerate()) return false;
      const body = document.getElementById(`msg-${node.id}`)?.querySelector('.msg-body') ?? null;
      this.ui.dialogs.open({ kind: 'branch', fromNodeId: node.id, quote: selectionWithin(body) });
      return true;
    },
    v: () => {
      // The focused reply, else the last reply above the focused message (or overall).
      const path = this.store.path();
      const focused = this.store.focusedInPath();
      const upTo = focused ? path.slice(0, path.indexOf(focused) + 1) : path;
      const node = upTo.findLast((n) => n.role === 'assistant');
      if (
        !node ||
        node.status !== 'complete' ||
        !this.store.canReview(this.store.branchOf(node.id))
      )
        return false;
      this.ui.dialogs.open({ kind: 'review', nodeId: node.id });
      return true;
    },
    l: () => {
      // Not a generating call: available while power is read-only.
      const node = this.store.focusedInPath() ?? this.store.leaf();
      if (!node) return false;
      this.ui.linkPick.set(null);
      this.ui.dialogs.open({ kind: 'link', fromNodeId: node.id });
      return true;
    },
    '/': () => this.composer.focus(),
    i: this.onTree(() => this.ui.toggleInspector()),
    // Text size: plain keys, so Ctrl/Cmd +/-/0 stay the browser's zoom. `=` is `+` unshifted.
    '+': this.onTree(() => this.textSize.increase()),
    '=': this.onTree(() => this.textSize.increase()),
    '-': this.onTree(() => this.textSize.decrease()),
    '0': this.onTree(() => this.textSize.reset()),
  };

  /** Words selected in one finished message of the thread on screen, as "Ask about this" takes them. */
  private selectedWords(): ComposerLead | null {
    const found = selectedMessageQuote(document.querySelector('.messages'), window.getSelection());
    const node = found ? this.store.index()?.nodes.get(found.nodeId) : undefined;
    return found && node?.status === 'complete' ? found : null;
  }

  /** The focused message's finished reply, else the latest (`replyToAim`). */
  private replyLead(): ComposerLead | null {
    const nodeId = replyToAim(this.store.path(), this.store.focusedInPath()?.id ?? null);
    return nodeId === null ? null : { nodeId, quote: null };
  }

  handle(e: KeyboardEvent): void {
    dispatchShortcut(e, {
      closeTop: () => this.ui.closeTop(),
      dialogOpen: () => this.ui.dialogs.anyOpen(),
      toggleHelp: () => this.ui.dialogs.toggle({ kind: 'shortcuts' }),
      navigate: (step) => this.store.index() !== null && this.store.navigate(step),
      keys: this.keys,
    });
  }
}
