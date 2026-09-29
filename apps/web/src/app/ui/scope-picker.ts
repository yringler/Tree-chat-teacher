import { ChangeDetectionStrategy, Component, model } from '@angular/core';
import type { ShareScope } from '@tangent/shared';

let uid = 0;

export const SCOPES: readonly { value: ShareScope; label: string; help: string }[] = [
  { value: 'tree', label: 'Whole conversation', help: 'Every branch (private ones excluded).' },
  {
    value: 'subtree',
    label: 'This branch’s subtree',
    help: 'From the focused message down, with all branches below it.',
  },
  {
    value: 'path',
    label: 'Path to this message',
    help: 'Only the messages from the start to the focused message.',
  },
];

/** Scope radio group (+ "include ancestors" for subtree), shared by the share dialog and export menu. */
@Component({
  selector: 'app-scope-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <fieldset class="radio-group">
      <legend class="field-label">Scope</legend>
      @for (s of scopes; track s.value) {
        <label class="radio">
          <input
            type="radio"
            [name]="name"
            [value]="s.value"
            [checked]="scope() === s.value"
            (change)="scope.set(s.value)"
          />
          <span>
            <strong>{{ s.label }}</strong>
            <span class="muted small">{{ s.help }}</span>
          </span>
        </label>
      }
      @if (scope() === 'subtree') {
        <label class="check indent">
          <input
            type="checkbox"
            [checked]="includeAncestors()"
            (change)="includeAncestors.set(!includeAncestors())"
          />
          Include earlier messages as collapsed context
        </label>
      }
    </fieldset>
  `,
})
export class ScopePicker {
  readonly scope = model.required<ShareScope>();
  readonly includeAncestors = model.required<boolean>();
  protected readonly scopes = SCOPES;
  protected readonly name = `scope-${++uid}`;
}
