import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { ContextMode } from '@tangent/shared';
import { CONTEXT_MODE_META } from '@tangent/web-shared';

@Component({
  selector: 'app-mode-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="badge mode-{{ mode() }}" [attr.title]="info().longHelp">{{
    long() ? info().label : info().abbr
  }}</span>`,
})
export class ModeBadge {
  readonly mode = input.required<ContextMode>();
  readonly long = input(false);
  protected readonly info = computed(() => CONTEXT_MODE_META[this.mode()]);
}
