import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { ModelInfo } from '@tangent/shared';

/** What a suggestion chip reads: the model's name and, when it adds something, its id. */
export interface SuggestionText {
  /** The label without a trailing note in brackets: "Max (suggested)" → "Max"; else the id. */
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

/** One chip of `ModelSuggestions`. */
export interface ModelChip {
  /** The model id it puts in the field. */
  model: string;
  text: SuggestionText;
  /**
   * The route it moves the field to, when not the field's own: its
   * `routeKey`, and its label, which the chip shows (power's Normal and Max
   * run on the payer chosen with them).
   */
  route?: { key: string; label: string };
  /** It is what the field holds (`aria-pressed`). */
  pressed: boolean;
}

/** A chip for each listed model, named by `suggestionText`; the one of the field's id (`value`) pressed. */
export function modelChips(models: readonly ModelInfo[], value: string): ModelChip[] {
  const id = value.trim();
  return models.map((m) => ({ model: m.id, text: suggestionText(m), pressed: m.id === id }));
}

/**
 * The models of an `openModels` provider (OpenRouter, Tangent credit) as a
 * row of chips under its model id field, every one always in view and one
 * click from replacing the id: a `<datalist>` filters its options by the
 * field's text, so with the default (Normal) id in the field it offered only
 * that one. The chip of the current pick is pressed (`aria-pressed`).
 */
@Component({
  selector: 'app-model-suggestions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (chips().length > 0) {
      <div class="model-suggestions" role="group" [attr.aria-label]="label()">
        <!-- By position: a chip on another route may pick a model listed here too. -->
        @for (c of chips(); track $index) {
          <button
            type="button"
            class="model-chip"
            [attr.aria-pressed]="c.pressed"
            [title]="c.route ? c.model + ' on ' + c.route.label : c.model"
            (click)="picked.emit(c)"
          >
            {{ c.text.name }}
            @if (c.text.id) {
              <span class="model-chip-id">· {{ c.text.id }}</span>
            }
            @if (c.route) {
              <!-- Shown on phones too, which hide the id: who pays stays in view. -->
              <span class="model-chip-route"> · on {{ c.route.label }}</span>
            }
          </button>
        }
      </div>
    }
  `,
})
export class ModelSuggestions {
  readonly chips = input.required<readonly ModelChip[]>();
  /** The group's accessible name. */
  readonly label = input('Suggested models');
  readonly picked = output<ModelChip>();
}
