import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { APP_BASES, conversationHref, DEMO_BASES, DEMO_MODE, type AppId } from '../core/demo';

const MODES = [
  {
    app: 'power',
    label: 'Power',
    title: 'Power mode: every control, your own keys',
    experimental: false,
  },
  {
    app: 'simple',
    label: 'Learn',
    title: 'Learn mode: straight answers, with tangents to follow',
    experimental: false,
  },
  {
    app: 'canvas',
    label: 'Canvas',
    title: 'Canvas (experimental): your conversations as a map, every branch side by side',
    experimental: true,
  },
] as const;

/**
 * The Power / Learn / Canvas switch. The apps are served on one origin with
 * one sign-in, so switching is a full page load to the other app. Every app
 * shows the same conversations (one account per user), so with a
 * conversation open the switch opens that conversation and branch in the
 * other app; otherwise its home. In a demo it switches between the demos,
 * which share one in-browser store.
 */
@Component({
  selector: 'app-mode-switch',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav class="mode-switch" aria-label="Mode">
      @for (m of modes(); track m.app) {
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
  /** The open conversation, if any. */
  readonly treeId = input<string | null>(null);
  /** The open branch of that conversation, if known. */
  readonly branchId = input<string | null>(null);

  private readonly bases = inject(DEMO_MODE) ? DEMO_BASES : APP_BASES;

  protected readonly modes = computed(() =>
    MODES.map((m) => ({
      ...m,
      href: conversationHref(this.bases[m.app], this.treeId(), this.branchId()),
    })),
  );
}
