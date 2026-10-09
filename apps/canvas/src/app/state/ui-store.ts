import { computed, Injectable, signal } from '@angular/core';
import type { Point } from '../layout/layout-store';

/** A link shown in a toast; `href` is a full page load (e.g. the power app's `/billing`). */
/** The "Branch from here" dialog: one or many variants off one message. */
export interface BranchDialogState {
  fromNodeId: string;
  /** Text selected in the message, offered as the anchor quote. */
  quote: string | null;
  /**
   * The first message, already written ("Ask your own" under a reply, via its
   * gear): sent to every new lane, in place of the dialog's own field.
   */
  message?: string;
  /** Called once the lanes exist (e.g. to clear the field the message came from). */
  onCreated?: () => void;
}

/** The branch settings dialog (title, context mode, model, private). */
export interface BranchSettingsState {
  branchId: string;
}

/** "Search" for the other end of a new link: the picker dialog. */
export interface LinkDialogState {
  fromNodeId: string;
}

/**
 * Pick mode (`r`, or a click on a card's link port): every card offers
 * "Link here", and the next one clicked is linked to `fromNodeId`.
 */
export interface LinkPickState {
  fromNodeId: string;
}

/** A link being dragged out of a card's port: a rubber band from the port to the pointer (world coordinates). */
export interface LinkDragState {
  fromNodeId: string;
  from: Point;
  to: Point;
  /** The card under the pointer, where letting go would link to. */
  overNodeId: string | null;
}

/** Where a link was followed from: the canvas bar's "Back to ‘…’" returns there. */
export interface LinkReturn {
  branchId: string;
  /** The message the link was followed from (focused on the way back). */
  nodeId: string | null;
  /** The lane's title, for the pill. */
  label: string;
  /** Where the link went: the pill shows while that lane is selected. */
  toBranchId: string;
}

const EXPERIMENTAL_KEY = 'tangent.canvas.experimental-ack';

function storedAck(): boolean {
  try {
    return localStorage.getItem(EXPERIMENTAL_KEY) === '1';
  } catch {
    return false;
  }
}

/** View state that is not part of the URL: dialogs, the lineage toggle, collapsed lanes. */
@Injectable({ providedIn: 'root' })
export class UiStore {
  readonly menuOpen = signal(false);
  readonly keysOpen = signal(false);
  readonly branchDialog = signal<BranchDialogState | null>(null);
  readonly branchSettings = signal<BranchSettingsState | null>(null);
  readonly helpOpen = signal(false);
  readonly deleteAccountOpen = signal(false);
  /** The "experimental" notice until it is dismissed (remembered in this browser). */
  readonly experimentalAck = signal(storedAck());
  /**
   * Lineage view: the messages the model would see for the selected lane are
   * lit, every other message dims. Off, every card reads the same.
   */
  readonly lineage = signal(true);
  /** Lanes whose subtree is folded into a capsule. */
  readonly collapsed = signal<ReadonlySet<string>>(new Set());
  /** Bumped to ask the selected lane's composer to take focus. */
  readonly composerFocus = signal(0);
  /** The lines between linked messages (and their glyphs) are drawn. */
  readonly showLinks = signal(true);
  readonly linkDialog = signal<LinkDialogState | null>(null);
  readonly linkPick = signal<LinkPickState | null>(null);
  readonly linkDrag = signal<LinkDragState | null>(null);
  /** The link whose glyph was clicked: its popover (ends, note, remove). */
  readonly linkPopover = signal<{ linkId: string } | null>(null);
  readonly linkReturn = signal<LinkReturn | null>(null);
  /**
   * The lane the last focus request is for, when it names one: a lane just
   * created isn't on the canvas yet when it is asked, so its composer takes
   * the request once it renders (LaneComposer).
   */
  composerFocusLane: string | null = null;
  /**
   * A lane's message reached the server (its reply started): the lane's box,
   * still holding exactly that text, lets it go. Until then the text stays,
   * so a refused or failed send never loses it.
   */
  readonly composerSent = signal<{ seq: number; laneId: string; text: string } | null>(null);

  readonly anyDialogOpen = computed(
    () =>
      this.keysOpen() ||
      this.branchDialog() !== null ||
      this.branchSettings() !== null ||
      this.helpOpen() ||
      this.deleteAccountOpen() ||
      this.linkDialog() !== null,
  );

  /** Focus the selected lane's composer, or `laneId`'s (also once it first renders). */
  focusComposer(laneId: string | null = null): void {
    this.composerFocusLane = laneId;
    this.composerFocus.update((n) => n + 1);
  }

  markSent(laneId: string, text: string): void {
    this.composerSent.update((cur) => ({ seq: (cur?.seq ?? 0) + 1, laneId, text }));
  }

  acknowledgeExperimental(): void {
    this.experimentalAck.set(true);
    try {
      localStorage.setItem(EXPERIMENTAL_KEY, '1');
    } catch {
      // Storage unavailable: the notice comes back next time.
    }
  }

  /** Pick mode from `fromNodeId`; whatever else was linking from somewhere ends. */
  startLinkPick(fromNodeId: string): void {
    this.linkPopover.set(null);
    this.linkDialog.set(null);
    this.linkPick.set({ fromNodeId });
  }

  /** Every link interaction ends (another tree opened). */
  clearLinkState(): void {
    this.linkDialog.set(null);
    this.linkPick.set(null);
    this.linkDrag.set(null);
    this.linkPopover.set(null);
    this.linkReturn.set(null);
  }

  toggleCollapsed(branchId: string): void {
    this.collapsed.update((set) => {
      const next = new Set(set);
      if (next.has(branchId)) next.delete(branchId);
      else next.add(branchId);
      return next;
    });
  }

  /** Unfolds every lane on the way to `branchIds` (so a selected lane is never hidden). */
  expand(branchIds: Iterable<string>): void {
    const set = this.collapsed();
    const wanted = [...branchIds].filter((id) => set.has(id));
    if (wanted.length === 0) return;
    this.collapsed.update((cur) => {
      const next = new Set(cur);
      for (const id of wanted) next.delete(id);
      return next;
    });
  }

  /** Escape: closes the top-most overlay. Returns true if something closed. */
  closeTop(): boolean {
    if (this.linkDrag()) {
      this.linkDrag.set(null);
      return true;
    }
    if (this.linkPopover()) {
      this.linkPopover.set(null);
      return true;
    }
    if (this.deleteAccountOpen()) {
      this.deleteAccountOpen.set(false);
      return true;
    }
    if (this.helpOpen()) {
      this.helpOpen.set(false);
      return true;
    }
    if (this.linkDialog()) {
      this.linkDialog.set(null);
      return true;
    }
    if (this.branchDialog()) {
      this.branchDialog.set(null);
      return true;
    }
    if (this.branchSettings()) {
      this.branchSettings.set(null);
      return true;
    }
    if (this.keysOpen()) {
      this.keysOpen.set(false);
      return true;
    }
    if (this.menuOpen()) {
      this.menuOpen.set(false);
      return true;
    }
    if (this.linkPick()) {
      this.linkPick.set(null);
      return true;
    }
    return false;
  }
}
