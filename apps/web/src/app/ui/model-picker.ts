import { ChangeDetectionStrategy, Component, computed, inject, model } from '@angular/core';
import { parseRouteKey, providerRouteKey } from '@tangent/shared';
import { modelHint, ModelSuggestions, routeSuffix } from '@tangent/web-shared';
import { TreeStore } from '../state/tree-store';

let uid = 0;

/**
 * Provider + model. Providers without an API key, and routes whose funding
 * needs the membership the user lacks, are listed but disabled.
 * The provider select picks a route (`route`, a `routeKey`): a provider and
 * who pays for it, so the built-in endpoint shows twice in power, as the
 * user's OpenRouter and as Tangent credit.
 * A provider with `openModels` (OpenRouter, Tangent credit) takes any model
 * id it serves: a text field with its listed models as chips under it, all
 * in view and one click away (ModelSuggestions). Every other provider offers
 * a select of its listed models.
 */
@Component({
  selector: 'app-model-picker',
  imports: [ModelSuggestions],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="field-row">
      <label class="field">
        <span class="field-label">Provider</span>
        <select #ps [id]="id + '-p'" [value]="route()" (change)="pickProvider(ps.value)">
          @if (!known()) {
            <option [value]="route()">{{ unknownLabel() }} (not configured)</option>
          }
          @for (p of store.account.providers(); track key(p)) {
            @let locked = store.account.routeLocked(p);
            <option
              [value]="key(p)"
              [disabled]="!p.available || locked"
              [selected]="key(p) === route()"
            >
              {{ p.label }}{{ suffix(p, locked) }}
            </option>
          }
        </select>
      </label>
      @if (open()) {
        <!-- A div, not a label: the label would name the field after the chips too. -->
        <div class="field">
          <label class="field-label" [for]="id + '-m'">Model</label>
          <input
            #mi
            type="text"
            [id]="id + '-m'"
            [value]="modelId()"
            (input)="modelId.set(mi.value)"
            (change)="modelId.set(mi.value.trim())"
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
            [value]="modelId()"
            (picked)="modelId.set($event)"
          />
          @if (hint(); as h) {
            <span class="field-error small" [id]="id + '-h'">{{ h }}</span>
          }
        </div>
      } @else {
        <label class="field">
          <span class="field-label">Model</span>
          <select #ms [id]="id + '-m'" [value]="modelId()" (change)="modelId.set(ms.value)">
            @if (!modelKnown()) {
              <option [value]="modelId()">{{ modelId() || '—' }}</option>
            }
            @for (m of models(); track m.id) {
              <option [value]="m.id" [selected]="m.id === modelId()">{{ m.label }}</option>
            }
          </select>
        </label>
      }
    </div>
  `,
})
export class ModelPicker {
  protected readonly store = inject(TreeStore);
  /** The picked route: a `routeKey` (provider id, `@credit` for Tangent credit). */
  readonly route = model.required<string>();
  readonly modelId = model.required<string>();
  protected readonly id = `mp${++uid}`;
  protected readonly suffix = routeSuffix;
  protected readonly key = providerRouteKey;

  private readonly provider = computed(
    () => this.store.account.providerMap().get(this.route()) ?? null,
  );
  /** A route no provider offers (e.g. Tangent credit on a server that stopped selling it). */
  protected readonly unknownLabel = computed(() => {
    const { providerId, funding } = parseRouteKey(this.route());
    return funding === 'credit' ? `${providerId} on Tangent credit` : providerId;
  });
  protected readonly known = computed(() => this.provider() !== null);
  protected readonly open = computed(() => this.provider()?.openModels ?? false);
  protected readonly models = computed(() => this.provider()?.models ?? []);
  protected readonly modelKnown = computed(() =>
    this.models().some((m) => m.id === this.modelId()),
  );
  protected readonly hint = computed(() => modelHint(this.provider(), this.modelId()));

  protected pickProvider(route: string): void {
    this.route.set(route);
    const p = this.store.account.providerMap().get(route);
    if (p) this.modelId.set(p.defaultModel);
  }
}
