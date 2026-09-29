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
import { Icon } from './icon';

let uid = 0;

/** Modal shell: backdrop, title bar, projected body. Escape is handled globally (UiStore.closeTop). */
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
        <h2 [id]="titleId">{{ heading() }}</h2>
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
  readonly closed = output();
  protected readonly titleId = `modal-title-${++uid}`;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  constructor() {
    afterNextRender(() => {
      const el = this.host.nativeElement;
      const target =
        el.querySelector<HTMLElement>('[autofocus]') ??
        el.querySelector<HTMLElement>(
          '.modal-body input, .modal-body textarea, .modal-body select, .modal-body button',
        );
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
