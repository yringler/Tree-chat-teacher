import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injectable,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Icon } from './icon';

/** What the controller can ask of one message box. */
interface ComposerBox {
  /** The branch the box writes in; null: whichever branch is open (one box per page). */
  branchId(): string | null;
  /** The box a focus request that names no branch goes to (the selected lane's, or the only one). */
  current(): boolean;
  focus(): void;
  insert(text: string): void;
  /** `text` reached the server: the box lets it go if it still holds exactly that. */
  release(text: string): void;
}

/**
 * The app's message boxes (`Composer`), asked directly: take focus, take
 * text handed over from elsewhere, let a sent message go. A focus request
 * for a branch whose box isn't on the page yet (a lane just created) waits
 * for that box.
 */
@Injectable({ providedIn: 'root' })
export class ComposerController {
  private readonly boxes = new Set<ComposerBox>();
  private pendingFocus: string | null = null;

  /** A box on the page; the returned function takes it off. */
  attach(box: ComposerBox): () => void {
    this.boxes.add(box);
    if (this.pendingFocus !== null && box.branchId() === this.pendingFocus) {
      this.pendingFocus = null;
      box.focus();
    }
    return () => this.boxes.delete(box);
  }

  /** Focuses the box of `branchId` (also once it first renders), or the current one. */
  focus(branchId: string | null = null): void {
    const box = this.find(branchId);
    this.pendingFocus = box ? null : branchId;
    box?.focus();
  }

  /** Appends `text` to the current box's draft and focuses it (e.g. a review's corrections). */
  insert(text: string): void {
    this.find(null)?.insert(text);
  }

  /**
   * A message of `branchId` reached the server (its reply started): its box,
   * still holding exactly that text, lets it go. Until then the text stays,
   * so a refused or failed send never loses it.
   */
  sent(branchId: string, text: string): void {
    for (const box of this.boxes) {
      const own = box.branchId();
      if (own === null || own === branchId) box.release(text);
    }
  }

  private find(branchId: string | null): ComposerBox | undefined {
    return [...this.boxes].find((b) =>
      branchId === null ? b.current() : b.branchId() === branchId,
    );
  }
}

/** Focusing pops up the on-screen keyboard on touch devices, so only pointers that hover autofocus. */
function hovers(): boolean {
  return matchMedia('(hover: hover)').matches;
}

/**
 * Message box of every app. Enter sends, Shift+Enter inserts a newline;
 * Stop replaces Send while a reply streams; with `canCompare`, Compare beside
 * Send asks Normal and Max (the host opens its dialog). The text stays until
 * the message is in the tree (`ComposerController.sent`, on the reply's
 * start), so a send the server refuses (no key, no credit, a network
 * failure…) leaves it where it was typed.
 */
@Component({
  selector: 'app-composer',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="composer" (submit)="$event.preventDefault(); submit()">
      <label class="sr-only" [attr.for]="inputId()">{{ label() }}</label>
      <textarea
        #box
        [id]="inputId()"
        rows="1"
        enterkeyhint="send"
        [placeholder]="placeholder()"
        [value]="text()"
        [disabled]="disabled()"
        (input)="onInput(box)"
        (keydown)="onKey($event)"
      ></textarea>
      @if (busy()) {
        <button
          type="button"
          class="btn btn-danger"
          [class.btn-sm]="compact()"
          [attr.aria-label]="stopLabel()"
          (click)="stop.emit()"
        >
          <app-icon name="stop" [size]="iconSize()" /> Stop
        </button>
      } @else if (!hideSend()) {
        @if (canCompare()) {
          <button
            type="button"
            class="btn btn-ghost"
            [disabled]="disabled() || !text().trim()"
            title="Answer with Normal and Max, then keep one (uses both)"
            aria-label="Compare Normal and Max"
            (click)="compareNow()"
          >
            <app-icon name="compare" /><span class="hide-narrow"> Compare</span>
          </button>
        }
        <button
          type="submit"
          class="btn btn-primary"
          [class.btn-sm]="compact()"
          [disabled]="disabled() || !text().trim()"
          [attr.aria-label]="sendLabel()"
        >
          <app-icon name="send" [size]="iconSize()" />
          @if (!compact()) {
            <span class="hide-narrow"> Send</span>
          }
        </button>
      }
    </form>
  `,
  host: { class: 'composer-host' },
})
export class Composer {
  private readonly controller = inject(ComposerController);
  readonly placeholder = input('Message…');
  readonly label = input('Message');
  readonly inputId = input('composer-input');
  readonly sendLabel = input('Send');
  readonly stopLabel = input('Stop the reply');
  /** The branch this box writes in, where a page has one box per branch (the canvas's lanes). */
  readonly branchId = input<string | null>(null);
  /** Takes the focus requests that name no branch (on the canvas: the selected lane's box). */
  readonly current = input(true);
  /** Input disabled (e.g. while a reply is streaming). */
  readonly disabled = input(false);
  /** Show the Stop button instead of Send. */
  readonly busy = input(false);
  /** No Send button (the host form has its own). */
  readonly hideSend = input(false);
  /** Small buttons and an icon-only Send (a canvas lane). */
  readonly compact = input(false);
  readonly autofocus = input(false);
  /** The box grows with its text up to this height (px), then scrolls. */
  readonly maxHeight = input(320);
  /**
   * True: the text goes once the message is in the tree, never before.
   * False: it stays (the host navigates away on success).
   */
  readonly clearOnSend = input(true);
  /** Draft to start from when the box is empty (a message that couldn't be sent). */
  readonly initial = input('');
  /** Offer Compare beside Send (Normal and Max both answer; one is kept). */
  readonly canCompare = input(false);
  readonly send = output<string>();
  readonly stop = output();
  /** Compare the message: like Send, the text stays until the picked answer is in the tree. */
  readonly compare = output<string>();
  /** Every edit, for hosts that read the draft themselves. */
  readonly draft = output<string>();

  protected readonly text = signal('');
  private readonly box = viewChild.required<ElementRef<HTMLTextAreaElement>>('box');

  constructor() {
    const detach = this.controller.attach({
      branchId: () => untracked(this.branchId),
      current: () => untracked(this.current),
      focus: () => queueMicrotask(() => this.box().nativeElement.focus({ preventScroll: true })),
      insert: (text) => this.append(text),
      release: (text) => {
        if (untracked(this.clearOnSend) && untracked(this.text).trim() === text) this.setText('');
      },
    });
    inject(DestroyRef).onDestroy(detach);
    afterNextRender(() => {
      if (this.autofocus() && hovers()) this.box().nativeElement.focus();
    });
    // A message handed back (it couldn't be sent) fills an empty box.
    effect(() => {
      const initial = this.initial();
      if (!initial || untracked(this.text)) return;
      this.setText(initial);
    });
    // Re-focus when the composer is enabled again after a reply: the page's
    // one box (a canvas lane's box leaves the focus where the user put it).
    effect(() => {
      if (
        !this.disabled() &&
        untracked(this.branchId) === null &&
        document.activeElement === document.body &&
        hovers()
      ) {
        queueMicrotask(() => this.box().nativeElement.focus({ preventScroll: true }));
      }
    });
  }

  protected iconSize(): number {
    return this.compact() ? 14 : 16;
  }

  protected onInput(box: HTMLTextAreaElement): void {
    this.text.set(box.value);
    this.draft.emit(box.value);
    this.autosize(box);
  }

  protected onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.submit();
    }
  }

  /** Kept until the message is in the tree (`ComposerController.sent`). */
  protected submit(): void {
    const content = this.text().trim();
    if (!content || this.disabled() || this.busy()) return;
    this.send.emit(content);
  }

  protected compareNow(): void {
    const content = this.text().trim();
    if (!content || this.disabled() || this.busy()) return;
    this.compare.emit(content);
  }

  private append(text: string): void {
    const draft = untracked(this.text).trimEnd();
    const next = draft ? `${draft}\n\n${text}` : text;
    this.setText(next);
    queueMicrotask(() => {
      const box = this.box().nativeElement;
      box.focus();
      box.setSelectionRange(next.length, next.length);
    });
  }

  private setText(text: string): void {
    this.text.set(text);
    this.draft.emit(text);
    // After the view exists (an effect's first run can come before it).
    queueMicrotask(() => {
      const box = this.box().nativeElement;
      box.value = text;
      this.autosize(box);
    });
  }

  private autosize(box: HTMLTextAreaElement): void {
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, untracked(this.maxHeight))}px`;
  }
}
