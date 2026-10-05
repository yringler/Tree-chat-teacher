import { ChangeDetectionStrategy, Component, computed, inject, model } from '@angular/core';
import {
  isModelAllowed,
  parseRouteKey,
  providerRouteKey,
  type ProviderInfo,
} from '@tangent/shared';
import { TreeStore } from '../state/tree-store';

let uid = 0;

/**
 * What is wrong with `model` for `provider`, or null when nothing is. Only an
 * `openModels` provider takes typed ids (the others offer a select of their
 * listed models, so their choice is always one the server allows).
 */
export function modelHint(provider: ProviderInfo | null, model: string): string | null {
  if (!provider?.openModels) return null;
  if (model.trim() === '') return 'Enter a model id, or pick one of the suggestions.';
  if (!isModelAllowed(provider, model))
    return 'Not a model id: use letters, digits and . _ - : / (like vendor/model-name).';
  return null;
}

/** Why a provider can't be picked, appended to its label; empty when it can. */
export function unavailableSuffix(p: ProviderInfo): string {
  if (p.available) return '';
  return p.acceptsUserKey ? ' — missing API key' : ' — unavailable';
}

/**
 * `unavailableSuffix`, or for a route whose funding needs the membership the
 * user lacks (`locked`, see TreeStore `routeLocked`), that.
 */
export function routeSuffix(p: ProviderInfo, locked: boolean): string {
  return locked && p.available ? ' — needs a membership' : unavailableSuffix(p);
}

/**
 * Provider + model. Providers without an API key, and routes whose funding
 * needs the membership the user lacks, are listed but disabled.
 * The provider select picks a route (`route`, a `routeKey`): a provider and
 * who pays for it, so the built-in endpoint shows twice in power, as the
 * user's OpenRouter and as Tangent credit.
 * A provider with `openModels` (OpenRouter, Tangent credit) takes any model
 * id it serves: a text field whose datalist keeps the suggestions one click
 * away. Every other provider offers a select of its listed models.
 */
@Component({
  selector: 'app-model-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="field-row">
      <label class="field">
        <span class="field-label">Provider</span>
        <select #ps [id]="id + '-p'" [value]="route()" (change)="pickProvider(ps.value)">
          @if (!known()) {
            <option [value]="route()">{{ unknownLabel() }} (not configured)</option>
          }
          @for (p of store.providers(); track key(p)) {
            @let locked = store.routeLocked(p);
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
      <label class="field">
        <span class="field-label">Model</span>
        @if (open()) {
          <input
            #mi
            type="text"
            [id]="id + '-m'"
            [attr.list]="id + '-ml'"
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
          <datalist [id]="id + '-ml'">
            @for (m of models(); track m.id) {
              <option [value]="m.id">{{ m.label }}</option>
            }
          </datalist>
          @if (hint(); as h) {
            <span class="field-error small" [id]="id + '-h'">{{ h }}</span>
          }
        } @else {
          <select #ms [id]="id + '-m'" [value]="modelId()" (change)="modelId.set(ms.value)">
            @if (!modelKnown()) {
              <option [value]="modelId()">{{ modelId() || '—' }}</option>
            }
            @for (m of models(); track m.id) {
              <option [value]="m.id" [selected]="m.id === modelId()">{{ m.label }}</option>
            }
          </select>
        }
      </label>
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

  private readonly provider = computed(() => this.store.providerMap().get(this.route()) ?? null);
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
    const p = this.store.providerMap().get(route);
    if (p) this.modelId.set(p.defaultModel);
  }
}
