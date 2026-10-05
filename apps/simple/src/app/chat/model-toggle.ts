import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { ModelInfo } from '@tangent/shared';

let uid = 0;

/**
 * Segmented Smart/Simple switch over the provider's models. `lockedHint`
 * disables it and says why (on the community pool, which uses one model).
 */
@Component({
  selector: 'app-model-toggle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="segmented"
      role="radiogroup"
      [attr.aria-label]="label()"
      [attr.aria-describedby]="lockedHint() ? hintId : null"
    >
      @for (m of models(); track m.id) {
        <button
          type="button"
          role="radio"
          class="segment"
          [class.is-on]="m.id === value()"
          [attr.aria-checked]="m.id === value()"
          [disabled]="disabled() || lockedHint() !== null"
          [title]="lockedHint() ?? hintFor(m)"
          (click)="m.id !== value() && changed.emit(m.id)"
        >
          {{ m.label }}
        </button>
      }
    </div>
    @if (lockedHint(); as hint) {
      <span class="sr-only" [id]="hintId">{{ hint }}</span>
    }
  `,
})
export class ModelToggle {
  readonly models = input.required<readonly ModelInfo[]>();
  readonly value = input<string | null>(null);
  readonly disabled = input(false);
  readonly label = input('Tutor');
  /** Disables the switch, saying why (e.g. "The community pool uses Simple."). */
  readonly lockedHint = input<string | null>(null);
  protected readonly hintId = `model-toggle-hint-${++uid}`;
  readonly changed = output<string>();

  protected hintFor(m: ModelInfo): string {
    switch (m.label.toLowerCase()) {
      case 'smart':
        return 'Smart: deeper explanations';
      case 'simple':
        return 'Simple: quicker, cheaper answers';
      default:
        return m.label;
    }
  }
}
