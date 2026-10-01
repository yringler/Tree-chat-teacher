import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { ModelInfo } from '@tangent/shared';

/** Segmented Smart/Simple switch over the provider's models. */
@Component({
  selector: 'app-model-toggle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="segmented" role="radiogroup" [attr.aria-label]="label()">
      @for (m of models(); track m.id) {
        <button
          type="button"
          role="radio"
          class="segment"
          [class.is-on]="m.id === value()"
          [attr.aria-checked]="m.id === value()"
          [disabled]="disabled()"
          [title]="hintFor(m)"
          (click)="m.id !== value() && changed.emit(m.id)"
        >
          {{ m.label }}
        </button>
      }
    </div>
  `,
})
export class ModelToggle {
  readonly models = input.required<readonly ModelInfo[]>();
  readonly value = input<string | null>(null);
  readonly disabled = input(false);
  readonly label = input('Tutor');
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
