import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { APP_BASES, DEMO_BASES, DEMO_MODE, type AppId } from '../core/demo';

/**
 * The Power / Learn / Canvas switch. The apps are served on one origin with
 * one sign-in, so switching is a full page load to the other app's home.
 * Every app shows the same conversations (one account per user); Canvas is
 * an experimental view of them. In a demo it switches between the demos.
 */
@Component({
  selector: 'app-mode-switch',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav class="mode-switch" aria-label="Mode">
      @for (m of modes; track m.app) {
        @if (m.app === current()) {
          <span
            class="mode-switch-opt is-current"
            [class.is-experimental]="m.experimental"
            aria-current="page"
            [attr.title]="m.title"
          >
            {{ m.label }}
          </span>
        } @else {
          <a
            class="mode-switch-opt"
            [class.is-experimental]="m.experimental"
            [href]="m.href"
            [attr.title]="'Switch to ' + m.title"
          >
            {{ m.label }}
          </a>
        }
      }
    </nav>
  `,
})
export class ModeSwitch {
  /** The app this switch is shown in. */
  readonly current = input.required<AppId>();

  private readonly demo = inject(DEMO_MODE);

  protected readonly modes = [
    {
      app: 'power',
      label: 'Power',
      href: this.demo ? DEMO_BASES.power : APP_BASES.power,
      title: 'Power mode: every control, your own keys',
      experimental: false,
    },
    {
      app: 'simple',
      label: 'Learn',
      href: this.demo ? DEMO_BASES.simple : APP_BASES.simple,
      title: 'Learn mode: straight answers, with tangents to follow',
      experimental: false,
    },
    {
      app: 'canvas',
      label: 'Canvas',
      href: this.demo ? DEMO_BASES.canvas : APP_BASES.canvas,
      title: 'Canvas (experimental): your power conversations as a map, every branch side by side',
      experimental: true,
    },
  ] as const;
}
