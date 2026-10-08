import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { ContextMode } from '@tangent/shared';

export const MODE_INFO: Record<ContextMode, { short: string; label: string; help: string }> = {
  path: {
    short: 'path',
    label: 'Full path',
    help: 'Sends everything the parent branch had at the branch point, then this branch.',
  },
  summary: {
    short: 'sum',
    label: 'Summary',
    help: 'Sends a generated summary of the parent context (focused on the quote), then this branch.',
  },
  message: {
    short: 'msg',
    label: 'Parent message',
    help: 'Sends only the message you branched from and the anchor quote, no other earlier messages.',
  },
  independent: {
    short: 'ind',
    label: 'Independent',
    help: 'Starts fresh: only the system prompt and the anchor quote, no earlier messages.',
  },
};

@Component({
  selector: 'app-mode-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span
    class="badge mode-{{ mode() }}"
    [attr.title]="info().label + ' context: ' + info().help"
    >{{ long() ? info().label : info().short }}</span
  >`,
})
export class ModeBadge {
  readonly mode = input.required<ContextMode>();
  readonly long = input(false);
  protected readonly info = computed(() => MODE_INFO[this.mode()]);
}
