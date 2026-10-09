import { ChangeDetectionStrategy, Component, model } from '@angular/core';
import { CONTEXT_MODES, type ContextMode } from '@tangent/shared';
import { CONTEXT_MODE_META } from '@tangent/web-shared';

let uid = 0;

/** Context mode radio group with one-line explanations. */
@Component({
  selector: 'app-mode-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <fieldset class="radio-group">
      <legend class="field-label">Context</legend>
      @for (m of modes; track m) {
        <label class="radio">
          <input
            type="radio"
            [name]="name"
            [value]="m"
            [checked]="mode() === m"
            (change)="mode.set(m)"
          />
          <span>
            <strong class="mode-name mode-text-{{ m }}">{{ info[m].label }}</strong>
            <span class="muted small">{{ info[m].help }}</span>
          </span>
        </label>
      }
    </fieldset>
  `,
})
export class ModePicker {
  readonly mode = model.required<ContextMode>();
  protected readonly modes = CONTEXT_MODES;
  protected readonly info = CONTEXT_MODE_META;
  protected readonly name = `mode-${++uid}`;
}
