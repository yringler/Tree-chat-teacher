import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import type { AccountMode } from '@tangent/shared';
import { DEMO_BASES, DEMO_MODE } from '../core/demo';

/**
 * The Power / Learn switch. Both apps are served on one origin with one
 * sign-in, so switching is a full page load to the other app's home. The
 * modes keep separate conversations (every user has one account per mode).
 * In a demo it switches between the two demos, which keep separate
 * conversations too.
 */
@Component({
  selector: 'app-mode-switch',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav class="mode-switch" aria-label="Mode">
      @for (m of modes; track m.mode) {
        @if (m.mode === current()) {
          <span class="mode-switch-opt is-current" aria-current="page" [attr.title]="m.title">
            {{ m.label }}
          </span>
        } @else {
          <a class="mode-switch-opt" [href]="m.href" [attr.title]="'Switch to ' + m.title">
            {{ m.label }}
          </a>
        }
      }
    </nav>
  `,
})
export class ModeSwitch {
  /** The app this switch is shown in. */
  readonly current = input.required<AccountMode>();

  private readonly demo = inject(DEMO_MODE);

  protected readonly modes = [
    {
      mode: 'power',
      label: 'Power',
      href: this.demo ? DEMO_BASES.power : '/',
      title: 'Power mode: every control, your own keys',
    },
    {
      mode: 'simple',
      label: 'Learn',
      href: this.demo ? DEMO_BASES.simple : '/learn/',
      title: 'Learn mode: a Socratic tutor',
    },
  ] as const;
}
