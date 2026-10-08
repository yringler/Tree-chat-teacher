import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import {
  isModelAllowed,
  type Branch,
  type BranchFunding,
  type ProviderInfo,
} from '@tangent/shared';
import { ModelSuggestions } from '@tangent/web-shared';

let uid = 0;

/**
 * What is wrong with `model` for `provider`, or null when nothing is. Only an
 * `openModels` provider takes typed ids. (A copy of the power app's
 * ModelPicker rule: canvas doesn't import from apps/web.)
 */
export function modelHint(provider: ProviderInfo | null, model: string): string | null {
  if (!provider?.openModels) return null;
  if (model.trim() === '') return 'Enter a model id, or pick one of the suggestions.';
  if (!isModelAllowed(provider, model))
    return 'Not a model id: use letters, digits and . _ - : / (like vendor/model-name).';
  return null;
}

/**
 * Why a route can't be picked, appended to its label; empty when it can: no
 * key, unavailable, or (`locked`, see CanvasStore `routeLocked`) a funding
 * that needs the membership the user lacks. (The power app's rule too.)
 */
export function routeSuffix(p: ProviderInfo, locked: boolean): string {
  if (p.available) return locked ? ' — needs a membership' : '';
  return p.acceptsUserKey ? ' — missing API key' : ' — unavailable';
}

/**
 * The route and model a new lane starts on: its parent lane's, unless that
 * one can't generate here (`parentUsable` false: its funding needs the
 * membership the user lacks, or its own key isn't saved in this browser);
 * then `fallback`, the default route of a new conversation, keeping the
 * parent's model where that route serves it.
 */
export function laneRoute(
  parent: Pick<Branch, 'providerId' | 'funding' | 'model'> | null,
  parentUsable: boolean,
  fallback: ProviderInfo | null,
): { providerId: string; funding: BranchFunding; model: string } {
  if (parent && parentUsable) {
    return { providerId: parent.providerId, funding: parent.funding, model: parent.model };
  }
  const keepModel =
    !!parent && fallback?.id === parent.providerId && isModelAllowed(fallback, parent.model);
  return {
    providerId: fallback?.id ?? '',
    funding: fallback?.funding ?? 'own-key',
    model: (keepModel ? parent.model : fallback?.defaultModel) ?? '',
  };
}

/**
 * The model of one provider. A provider with `openModels` (OpenRouter,
 * Tangent credit) takes any model id it serves: a text field with its listed
 * models as chips under it, all in view and one click away
 * (ModelSuggestions). Others offer a select of their listed models.
 */
@Component({
  selector: 'app-model-field',
  imports: [ModelSuggestions],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (provider()?.openModels) {
      <!-- A div, not a label: the label would name the field after the chips too. -->
      <div class="field">
        <label [class]="compact() ? 'sr-only' : 'field-label'" [for]="id">{{ label() }}</label>
        <input
          #mi
          type="text"
          [id]="id"
          [value]="model()"
          (input)="model.set(mi.value)"
          (change)="model.set(mi.value.trim())"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          maxlength="200"
          placeholder="vendor/model-name"
          [attr.aria-invalid]="hint() ? 'true' : null"
          [attr.aria-describedby]="hint() ? id + '-h' : null"
        />
        <app-model-suggestions
          [models]="models()"
          [value]="model()"
          [label]="label() + ' suggestions'"
          (picked)="model.set($event)"
        />
        @if (hint(); as h) {
          <span class="field-error small" [id]="id + '-h'">{{ h }}</span>
        }
      </div>
    } @else {
      <label class="field">
        <span [class]="compact() ? 'sr-only' : 'field-label'">{{ label() }}</span>
        <select #ms [value]="model()" (change)="model.set(ms.value)">
          @if (!known()) {
            <option [value]="model()">{{ model() || '—' }}</option>
          }
          @for (m of models(); track m.id) {
            <option [value]="m.id" [selected]="m.id === model()">{{ m.label }}</option>
          }
        </select>
      </label>
    }
  `,
  host: { class: 'model-field' },
})
export class ModelField {
  readonly provider = input<ProviderInfo | null>(null);
  readonly label = input('Model');
  /** Visually hidden label (the variant rows of the branch dialog). */
  readonly compact = input(false);
  readonly model = model.required<string>();
  protected readonly id = `mf${++uid}`;

  protected readonly models = computed(() => this.provider()?.models ?? []);
  protected readonly known = computed(() => this.models().some((m) => m.id === this.model()));
  protected readonly hint = computed(() => modelHint(this.provider(), this.model()));
}
