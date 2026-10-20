import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  input,
  OnDestroy,
  output,
} from '@angular/core';
import { pointerHovers } from './composer';
import { Icon } from './icon';

let uid = 0;

/** Modal shell: backdrop, title bar, projected body. Escape closes it from the app's document keydown (`dispatchShortcut`, which closes the top-most of the app's `Overlays`). */
@Component({
  selector: 'app-modal',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="backdrop" (click)="closed.emit()"></div>
    <section
      class="modal"
      [class.modal-wide]="wide()"
      role="dialog"
      aria-modal="true"
      [attr.aria-labelledby]="titleId"
    >
      <header class="modal-head">
        <h2 [id]="titleId" tabindex="-1">{{ heading() }}</h2>
        <button type="button" class="icon-btn" aria-label="Close" (click)="closed.emit()">
          <app-icon name="x" />
        </button>
      </header>
      <div class="modal-body">
        <ng-content />
      </div>
    </section>
  `,
  host: { class: 'modal-host' },
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
   * The part of the dialog the user asked to open it at (e.g. a section,
   * `tabindex="-1"`): it takes the focus on open, on a touch screen too,
   * which scrolls it into view. Never a text field, whose focus would pop up
   * the on-screen keyboard.
   */
  readonly openAt = input<HTMLElement | null>(null);
  readonly closed = output();
  protected readonly titleId = `modal-title-${++uid}`;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  constructor() {
    afterNextRender(() => {
      const el = this.host.nativeElement;
      const at = this.openAt();
      if (at) {
        at.focus();
        return;
      }
      // Where no pointer hovers (a touch screen), focusing a field pops up the
      // on-screen keyboard over the dialog, and focusing a control further
      // down scrolls the sheet: the heading takes the focus there.
      if (this.focusHeading() || !pointerHovers()) {
        el.querySelector<HTMLElement>('.modal-head h2')?.focus();
        return;
      }
      // The first usable control: not disabled, nor hidden by the layout (e.g.
      // Compare's tab bar on a wide screen); else the Close button.
      const usable = (c: HTMLElement) =>
        !c.matches(':disabled') && (typeof c.checkVisibility !== 'function' || c.checkVisibility());
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

  ngOnDestroy(): void {
    // Give focus back unless something else (e.g. the composer) has already taken it.
    const active = document.activeElement;
    const lost = !active || active === document.body || this.host.nativeElement.contains(active);
    if (lost && this.previouslyFocused?.isConnected) this.previouslyFocused.focus();
  }
}
