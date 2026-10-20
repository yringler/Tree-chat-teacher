import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  Injector,
  input,
  OnDestroy,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { pointerHovers } from './composer';
import { Icon } from './icon';

let uid = 0;

/**
 * Modal shell: backdrop, title bar, projected body. Escape closes it from
 * the app's document keydown (`dispatchShortcut`, which closes the top-most
 * of the app's `Overlays`). While it holds unsaved edits (`dirty`), Escape
 * and a backdrop tap, which are easy to hit by accident, ask before
 * discarding them instead; Close, like the dialog's Cancel, discards.
 */
@Component({
  selector: 'app-modal',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="backdrop" (click)="dismiss()"></div>
    <section
      class="modal"
      [class.modal-wide]="wide()"
      role="dialog"
      aria-modal="true"
      [attr.aria-labelledby]="titleId"
      (focusin)="noteFocus($event)"
    >
      <header class="modal-head" [attr.inert]="asking() ? '' : null">
        <h2 [id]="titleId" tabindex="-1">{{ heading() }}</h2>
        <button type="button" class="icon-btn" aria-label="Close" (click)="closed.emit()">
          <app-icon name="x" />
        </button>
      </header>
      <div class="modal-body" [attr.inert]="asking() ? '' : null">
        <ng-content />
      </div>
      @if (asking()) {
        <div class="modal-ask">
          <div
            class="modal-ask-card"
            role="alertdialog"
            aria-modal="true"
            [attr.aria-labelledby]="titleId + '-ask'"
          >
            <p [id]="titleId + '-ask'">Discard your changes?</p>
            <div class="form-actions">
              <button type="button" class="btn" (click)="discard()">Discard</button>
              <button type="button" class="btn btn-primary" (click)="keepEditing()" #keep>
                Keep editing
              </button>
            </div>
          </div>
        </div>
      }
    </section>
  `,
  host: { class: 'modal-host', '(keydown.escape)': 'onEscape($event)' },
})
export class Modal implements OnDestroy {
  readonly heading = input.required<string>();
  readonly wide = input(false);
  /**
   * The heading takes the focus on open, not the first control: for a dialog
   * read before it is edited, which should open at its top.
   */
  readonly focusHeading = input(false);
  /**
   * The part of the dialog the user asked to open it at: it takes the focus
   * on open, on a touch screen too, which scrolls it into view. A section
   * with `tabindex="-1"` takes the focus itself; any other is scrolled to its
   * top and hands the focus to its first choice (a checkbox, the checked
   * radio, a select or a button). Never a text field, whose focus would pop
   * up the on-screen keyboard.
   */
  readonly openAt = input<HTMLElement | null>(null);
  /**
   * Whether it holds edits that closing would lose, so Escape and the
   * backdrop ask first: the dialog's signal itself, read when the user asks
   * to close, so an edit made a moment before counts before the page has
   * caught up with it.
   */
  readonly dirty = input<() => boolean>(() => false);
  readonly closed = output();
  protected readonly titleId = `modal-title-${++uid}`;
  /** "Discard your changes?" is showing, over the dialog. */
  protected readonly asking = signal(false);
  private readonly keep = viewChild<ElementRef<HTMLElement>>('keep');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  /**
   * The last element in the dialog to hold the focus: where Keep editing
   * returns it. A backdrop tap has already taken the focus by the time it
   * asks, so the element focused then won't do.
   */
  private lastFocus: HTMLElement | null = null;
  /**
   * Escape pressed with the focus outside every dialog (on the page's body,
   * as after a click on a dialog's text or on a button that then went away)
   * reaches the app's document keydown without passing this dialog: it is
   * caught on its way down instead. With the focus inside, the host's own
   * keydown catches it, after any control in the dialog that answers Escape
   * itself.
   */
  private readonly escapeOutside = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !(e.target instanceof Element && e.target.closest('.modal-host'))) {
      this.onEscape(e);
    }
  };

  constructor() {
    document.addEventListener('keydown', this.escapeOutside, true);
    afterNextRender(() => {
      const el = this.host.nativeElement;
      const heading = el.querySelector<HTMLElement>('.modal-head h2');
      // Usable: not disabled, nor hidden by the layout (e.g. Compare's tab bar
      // on a wide screen).
      const usable = (c: HTMLElement) =>
        !c.matches(':disabled') && (typeof c.checkVisibility !== 'function' || c.checkVisibility());
      const at = this.openAt();
      if (at?.hasAttribute('tabindex')) {
        at.focus();
        return;
      }
      if (at) {
        // Its top in view, where its name is, rather than just the choice.
        at.scrollIntoView({ block: 'start' });
        const choices = at.querySelectorAll<HTMLElement>(
          'input[type=checkbox], input[type=radio]:checked, select, button',
        );
        (Array.from(choices).find(usable) ?? heading)?.focus({ preventScroll: true });
        return;
      }
      // Where no pointer hovers (a touch screen), focusing a field pops up the
      // on-screen keyboard over the dialog, and focusing a control further
      // down scrolls the sheet: the heading takes the focus there.
      if (this.focusHeading() || !pointerHovers()) {
        heading?.focus();
        return;
      }
      // The first usable control, else the Close button.
      const controls = el.querySelectorAll<HTMLElement>(
        '.modal-body input, .modal-body textarea, .modal-body select, .modal-body button',
      );
      const target =
        el.querySelector<HTMLElement>('[autofocus]') ??
        Array.from(controls).find(usable) ??
        el.querySelector<HTMLElement>('.modal-head button');
      target?.focus();
    });
  }

  /** A backdrop tap: closes, or asks first while there are unsaved edits (keeps editing while it asks). */
  protected dismiss(): void {
    if (this.asking()) this.keepEditing();
    else if (this.dirty()()) this.ask();
    else this.closed.emit();
  }

  /**
   * Escape, when this is the top-most dialog: asks first while there are
   * unsaved edits, and taking the key keeps the app from closing the dialog;
   * on the question, keeps editing. Otherwise the app's keydown closes it.
   */
  protected onEscape(e: Event): void {
    if (!(e instanceof KeyboardEvent) || e.defaultPrevented || e.isComposing) return;
    if (!this.isTop() || !(this.asking() || this.dirty()())) return;
    e.preventDefault();
    if (this.asking()) this.keepEditing();
    else this.ask();
  }

  protected noteFocus(e: FocusEvent): void {
    if (!this.asking() && e.target instanceof HTMLElement) this.lastFocus = e.target;
  }

  /** The user asked to close: the question takes the focus, on Keep editing, the default. */
  private ask(): void {
    this.asking.set(true);
    afterNextRender(() => this.keep()?.nativeElement.focus(), { injector: this.injector });
  }

  /** Back to the dialog, the focus where it was, the view where it was. */
  protected keepEditing(): void {
    this.asking.set(false);
    afterNextRender(
      () => {
        const back = this.lastFocus;
        const el = this.host.nativeElement;
        const target =
          back?.isConnected && el.contains(back)
            ? back
            : el.querySelector<HTMLElement>('.modal-head h2');
        target?.focus({ preventScroll: true });
      },
      { injector: this.injector },
    );
  }

  protected discard(): void {
    this.asking.set(false);
    this.closed.emit();
  }

  /** On top of every other dialog: the last in the page, which paints over the ones before it. */
  private isTop(): boolean {
    const all = document.querySelectorAll('.modal-host');
    return all[all.length - 1] === this.host.nativeElement;
  }

  ngOnDestroy(): void {
    document.removeEventListener('keydown', this.escapeOutside, true);
    // Give focus back unless something else (e.g. the composer) has already taken it.
    const active = document.activeElement;
    const lost = !active || active === document.body || this.host.nativeElement.contains(active);
    if (lost && this.previouslyFocused?.isConnected) this.previouslyFocused.focus();
  }
}
