import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { THREAD_ENDS } from '@tangent/shared';
import { Icon } from './icon';

/**
 * The down arrow that floats just above the message box while the end of
 * the thread is far below, and scrolls there. Hidden, it is inert: no
 * clicks, no focus, nothing read out. A press keeps the focus where it is,
 * so the message box keeps it and a phone's keyboard stays up.
 */
@Component({
  selector: 'app-jump-to-end',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'jump-to-end' },
  template: `<button
    type="button"
    class="jump-to-end-btn"
    [class.is-shown]="shown()"
    [attr.inert]="shown() ? null : ''"
    [attr.aria-label]="label"
    [title]="label"
    (mousedown)="$event.preventDefault()"
    (click)="jump.emit()"
  >
    <app-icon name="arrowDown" [size]="18" />
  </button>`,
})
export class JumpToEnd {
  readonly shown = input.required<boolean>();
  readonly jump = output();
  protected readonly label = THREAD_ENDS.toEnd;
}
