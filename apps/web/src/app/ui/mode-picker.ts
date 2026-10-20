import { ChangeDetectionStrategy, Component, model } from '@angular/core';
import { CONTEXT_MODES, type ContextMode } from '@tangent/shared';
import { CONTEXT_MODE_META } from '@tangent/web-shared';

let uid = 0;

/**
 * A tangent's Context group: what it is given besides its own messages, the
 * quote projected into it (a field, or a read-only excerpt), then the
 * context mode as radios with one-line explanations.
 */
@Component({
  selector: 'app-mode-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <fieldset class="settings-section context-group">
      <legend>Context</legend>
      <ng-content />
      <div class="radio-group">
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
      </div>
    </fieldset>
  `,
})
export class ModePicker {
  readonly mode = model.required<ContextMode>();
  protected readonly modes = CONTEXT_MODES;
  protected readonly info = CONTEXT_MODE_META;
  protected readonly name = `mode-${++uid}`;
}
