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
import type { ComposerLead, ComposerSend } from '@tangent/shared';
import { Icon, type IconName } from './icon';

/** What the controller can ask of one message box. */
export interface ComposerBox {
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
 * for that box. It also holds what the page's one box is aimed at (`lead`).
 */
@Injectable({ providedIn: 'root' })
export class ComposerController {
  private readonly boxes = new Set<ComposerBox>();
  private pendingFocus: string | null = null;
  private readonly aimed = signal<ComposerLead | null>(null);
  /**
   * What the page's one box is aimed at: a message, or words quoted from
   * it, that its next message asks about on a tangent made when it is sent.
   * The page drops it once the tangent is made or the view moves elsewhere.
   */
  readonly lead = this.aimed.asReadonly();

  /** A box on the page; the returned function takes it off. */
  attach(box: ComposerBox): () => void {
    this.boxes.add(box);
    if (this.pendingFocus !== null && box.branchId() === this.pendingFocus) {
      this.pendingFocus = null;
      box.focus();
    }
    return () => this.boxes.delete(box);
  }

  /**
   * Focuses the box of `branchId` (also once it first renders; a page with
   * one box for every branch has it focused at once), or the current one.
   */
  focus(branchId: string | null = null): void {
    const box = this.find(branchId) ?? (branchId === null ? undefined : this.single());
    this.pendingFocus = box ? null : branchId;
    box?.focus();
  }

  /** Aims the box at `lead` and focuses it; what is typed stays. */
  aim(lead: ComposerLead): void {
    this.aimed.set(lead);
    this.focus();
  }

  /** Takes the lead off the box; what is typed stays. */
  drop(): void {
    this.aimed.set(null);
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

  /** The page's one box, writing in whichever branch is open. */
  private single(): ComposerBox | undefined {
    return [...this.boxes].find((b) => b.branchId() === null);
  }

  private find(branchId: string | null): ComposerBox | undefined {
    return [...this.boxes].find((b) =>
      branchId === null ? b.current() : b.branchId() === branchId,
    );
  }
}

/**
 * Joins `box` to `controller` once it has rendered (`afterRender`), when its
 * inputs are set: a focus request for its branch, made before the box
 * existed, can only be matched then. Leaves on `onDestroy`.
 */
export function joinWhenRendered(
  controller: ComposerController,
  box: ComposerBox,
  afterRender: (fn: () => void) => void,
  onDestroy: (fn: () => void) => void,
): void {
  let detach: (() => void) | null = null;
  afterRender(() => (detach = controller.attach(box)));
  onDestroy(() => detach?.());
}

/** A sent `text` lets the box's `draft` go: only where the box clears on send, and only unedited. */
export function releasesDraft(draft: string, text: string, clearOnSend: boolean): boolean {
  return clearOnSend && draft.trim() === text;
}

/**
 * The box takes the focus back when it is enabled again after a reply: the
 * page's one box only (a canvas lane's box leaves the focus where the user
 * put it), when nothing else has it, and where focusing doesn't pop up an
 * on-screen keyboard.
 */
export function refocusesWhenEnabled(o: {
  disabled: boolean;
  branchId: string | null;
  nothingFocused: boolean;
  hovers: boolean;
}): boolean {
  return !o.disabled && o.branchId === null && o.nothingFocused && o.hovers;
}

/** Focusing pops up the on-screen keyboard on touch devices, so only pointers that hover autofocus. */
export function pointerHovers(): boolean {
  return matchMedia('(hover: hover)').matches;
}

/**
 * A way to send what is typed, offered in place of Send (Learn's Tangent ↳
 * and Next ➜). Its button carries `data-action="<id>"`, which the
 * walkthrough points at.
 */
export interface ComposerAction {
  id: string;
  label: string;
  /** None where the label carries its own glyph (the arrows of Tangent ↳ and Next ➜). */
  icon?: IconName;
  /** What the action is for: the button's tooltip and accessible description. */
  title: string;
  /** Filled, and fired by Enter; the other is outlined, and fired by Ctrl or Cmd+Enter. */
  primary: boolean;
}

/**
 * The composer rule's ways to send (`composerPlan`) as the box's buttons,
 * each tooltip naming its key where a pointer `hovers`: on a touch screen
 * Enter is a newline, and only the buttons send.
 */
export function sendActions(sends: readonly ComposerSend[], hovers: boolean): ComposerAction[] {
  return sends.map((s) => ({
    id: s.id,
    label: s.label,
    title: hovers ? `${s.hint} (${s.primary ? 'Enter' : 'Ctrl+Enter'})` : s.hint,
    primary: s.primary,
  }));
}

/**
 * Message box of every app. Enter sends, Shift+Enter inserts a newline; on
 * a touch screen (no hover) a plain Enter inserts a newline too and only the
 * buttons send: a phone's keyboard has no Shift+Enter, and a send there is
 * then a tap on a button that says where the message goes.
 * Stop replaces Send while a reply streams; with `canCompare`, Compare beside
 * Send (or the actions) asks Normal and Max (the host opens its dialog). With
 * `actions`, their buttons replace Send, in the order given, and emit `act`:
 * Enter fires the one marked `primary`, Ctrl or Cmd+Enter the other (the
 * primary when there is only one), so the keys follow the fill. The text
 * stays until the message is in the tree (`ComposerController.sent`, on the reply's
 * start), so a send the server refuses (no key, no credit, a network
 * failure…) leaves it where it was typed. An element marked `composerLead`
 * goes in the box before the text (the words a message asks about, say).
 * With `target`, the open box can name the reply a tangent from it starts
 * at, in the same place: whether it does (`nameTarget`) is decided as the
 * box opens and kept while it stays open, so the box doesn't change height
 * under the user's typing.
 *
 * `is-open` on the form marks it focused, for styles that change its size
 * then. A press elsewhere takes the focus on pointerdown, but the box keeps
 * `is-open` until that press ends: shrinking at once would move what is under
 * the pointer, and the click would land on something else.
 */
@Component({
  selector: 'app-composer',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form
      #form
      class="composer"
      [class.is-open]="open()"
      (focusin)="onFocusIn($event, form)"
      (focusout)="onFocusOut($event, form)"
      (submit)="$event.preventDefault(); submit()"
    >
      @if (open() && namesTarget() && target(); as from) {
        <!-- Mousedown is cancelled, so the focus (and a phone's keyboard) stays in the box. -->
        <span class="composer-lead">
          <button
            type="button"
            class="composer-target"
            title="Show the reply Tangent ↳ starts from"
            (mousedown)="$event.preventDefault()"
            (click)="showTarget.emit()"
          >
            <span aria-hidden="true">↳</span>
            <span class="composer-target-text">from “{{ from }}”</span>
          </button>
        </span>
      }
      <ng-content select="[composerLead]" />
      <label class="sr-only" [attr.for]="inputId()">{{ label() }}</label>
      <textarea
        #box
        [id]="inputId()"
        rows="1"
        [attr.enterkeyhint]="touch ? 'enter' : 'send'"
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
      } @else if (actions().length || !hideSend()) {
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
        @if (actions().length) {
          <div class="composer-actions">
            @for (a of actions(); track a.id) {
              <button
                type="button"
                class="btn composer-action"
                [class.is-primary]="a.primary"
                [class.btn-primary]="a.primary"
                [class.btn-sm]="compact()"
                [attr.data-action]="a.id"
                [title]="a.title"
                [attr.aria-description]="a.title"
                [disabled]="disabled() || !text().trim()"
                (click)="fire(a)"
              >
                @if (a.icon) {
                  <app-icon [name]="a.icon" [size]="iconSize()" />
                }
                {{ a.label }}
              </button>
            }
          </div>
        } @else {
          <button
            type="submit"
            class="btn btn-primary"
            [class.btn-sm]="compact()"
            [disabled]="disabled() || !text().trim()"
            [attr.aria-label]="sendLabel()"
            [attr.title]="sendTitle()"
            [attr.aria-description]="sendTitle()"
          >
            <app-icon name="send" [size]="iconSize()" />
            @if (!compact()) {
              <span class="hide-narrow"> Send</span>
            }
          </button>
        }
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
  /** What sending does, as Send's tooltip and description (none by default). */
  readonly sendTitle = input<string | null>(null);
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
  /** Offer Compare beside Send or the actions (Normal and Max both answer; one is kept). */
  readonly canCompare = input(false);
  /** Buttons in place of Send, each sending the text its own way (`act`). */
  readonly actions = input<readonly ComposerAction[]>([]);
  /** The opening words of the reply a tangent from the box starts at, for the box to name. */
  readonly target = input<string | null>(null);
  /** The box names `target` if this holds as it opens: the reply may not be the one in view. */
  readonly nameTarget = input(false);
  readonly send = output<string>();
  /** An action fired with the trimmed text: like Send, the text stays until the message is in the tree. */
  readonly act = output<{ id: string; text: string }>();
  readonly stop = output();
  /** Compare the message: like Send, the text stays until the picked answer is in the tree. */
  readonly compare = output<string>();
  /** Every edit, for hosts that read the draft themselves. */
  readonly draft = output<string>();
  /** The named target was clicked: the host shows that reply. */
  readonly showTarget = output();

  protected readonly text = signal('');
  /** Focused, or a press that took the focus away hasn't ended yet (`is-open`). */
  protected readonly open = signal(false);
  /** `nameTarget` as the box last opened. */
  protected readonly namesTarget = signal(false);
  /** A pointer is down somewhere on the page. */
  private pressing = false;
  /** No pointer hovers: a plain Enter is a newline, and the keyboard's key says so. */
  protected readonly touch = !pointerHovers();
  private readonly box = viewChild.required<ElementRef<HTMLTextAreaElement>>('box');

  constructor() {
    const destroyRef = inject(DestroyRef);
    joinWhenRendered(
      this.controller,
      {
        branchId: () => untracked(this.branchId),
        current: () => untracked(this.current),
        focus: () => queueMicrotask(() => this.box().nativeElement.focus({ preventScroll: true })),
        insert: (text) => this.append(text),
        release: (text) => {
          if (releasesDraft(untracked(this.text), text, untracked(this.clearOnSend)))
            this.setText('');
        },
      },
      (fn) => afterNextRender(fn),
      (fn) => destroyRef.onDestroy(fn),
    );
    afterNextRender(() => {
      if (this.autofocus() && pointerHovers()) this.box().nativeElement.focus();
    });
    // Captured, so a handler that stops the event can't hide the press.
    const press = (down: boolean) => () => (this.pressing = down);
    const listeners: [string, () => void][] = [
      ['pointerdown', press(true)],
      ['pointerup', press(false)],
      ['pointercancel', press(false)],
    ];
    for (const [type, fn] of listeners) window.addEventListener(type, fn, true);
    destroyRef.onDestroy(() => {
      for (const [type, fn] of listeners) window.removeEventListener(type, fn, true);
    });
    // A message handed back (it couldn't be sent) fills an empty box.
    effect(() => {
      const initial = this.initial();
      if (!initial || untracked(this.text)) return;
      this.setText(initial);
    });
    // Re-focus when the composer is enabled again after a reply.
    effect(() => {
      if (
        refocusesWhenEnabled({
          disabled: this.disabled(),
          branchId: untracked(this.branchId),
          nothingFocused: document.activeElement === document.body,
          hovers: pointerHovers(),
        })
      ) {
        queueMicrotask(() => this.box().nativeElement.focus({ preventScroll: true }));
      }
    });
  }

  /** Opens; coming from outside the box, it decides now whether to name the target. */
  protected onFocusIn(e: FocusEvent, form: HTMLFormElement): void {
    if (!(e.relatedTarget instanceof Node && form.contains(e.relatedTarget)))
      this.namesTarget.set(this.nameTarget());
    this.open.set(true);
  }

  /** Closes once the focus has left the form and any press that moved it has ended (and clicked). */
  protected onFocusOut(e: FocusEvent, form: HTMLFormElement): void {
    if (e.relatedTarget instanceof Node && form.contains(e.relatedTarget)) return;
    const close = () => {
      if (!form.contains(document.activeElement)) this.open.set(false);
    };
    if (!this.pressing) {
      close();
      return;
    }
    // After the click the press ends in: it comes in the same task as pointerup.
    const ended = () => {
      window.removeEventListener('pointerup', ended, true);
      window.removeEventListener('pointercancel', ended, true);
      setTimeout(close);
    };
    window.addEventListener('pointerup', ended, true);
    window.addEventListener('pointercancel', ended, true);
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
    const modified = e.ctrlKey || e.metaKey;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (modified || !this.touch)) {
      e.preventDefault();
      const actions = this.actions();
      const primary = actions.find((a) => a.primary) ?? actions[0];
      const other = actions.find((a) => a !== primary) ?? primary;
      const action = modified ? other : primary;
      if (action) this.fire(action);
      else this.submit();
    }
  }

  protected fire(action: ComposerAction): void {
    const content = this.text().trim();
    if (!content || this.disabled() || this.busy()) return;
    this.act.emit({ id: action.id, text: content });
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
