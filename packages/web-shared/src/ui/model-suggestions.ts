import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { ModelInfo } from '@tangent/shared';

/** What a suggestion chip reads: the model's name and, when it adds something, its id. */
export interface SuggestionText {
  /** The label without a trailing note in brackets: "Smart (suggested)" → "Smart"; else the id. */
  name: string;
  /** The id's last segment ("deepseek-v4-pro"), or null when it only repeats the name. */
  id: string | null;
}

const comparable = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function suggestionText(m: ModelInfo): SuggestionText {
  const name = m.label.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (!name) return { name: m.id, id: null };
  const id = m.id.slice(m.id.lastIndexOf('/') + 1);
  return { name, id: id && comparable(id) !== comparable(name) ? id : null };
}

/**
 * The listed models of an `openModels` provider (OpenRouter, Tangent credit)
 * as a row of chips under its model id field, every one always in view and
 * one click from replacing the id: a `<datalist>` filters its options by the
 * field's text, so with the default (smart) id in the field it offered only
 * that one. The chip of the current id is pressed (`aria-pressed`).
 */
@Component({
  selector: 'app-model-suggestions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (models().length > 0) {
      <div class="model-suggestions" role="group" [attr.aria-label]="label()">
        @for (m of models(); track m.id) {
          @let t = text(m);
          <button
            type="button"
            class="model-chip"
            [attr.aria-pressed]="m.id === value().trim()"
            [title]="m.id"
            (click)="picked.emit(m.id)"
          >
            {{ t.name }}
            @if (t.id) {
              <span class="model-chip-id">· {{ t.id }}</span>
            }
          </button>
        }
      </div>
    }
  `,
})
export class ModelSuggestions {
  readonly models = input.required<readonly ModelInfo[]>();
  /** The model id in the field. */
  readonly value = input.required<string>();
  /** The group's accessible name. */
  readonly label = input('Suggested models');
  readonly picked = output<string>();
  protected readonly text = suggestionText;
}
