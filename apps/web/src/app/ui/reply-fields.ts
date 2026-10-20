import { ChangeDetectionStrategy, Component, computed, inject, model } from '@angular/core';
import {
  DEFAULT_GROUNDING_MODE,
  GROUNDING_MODES,
  parseRouteKey,
  routeKey,
  type Branch,
  type GroundingMode,
  type UpdateBranchRequest,
} from '@tangent/shared';
import { TreeStore } from '../state/tree-store';
import { ModelPicker } from './model-picker';

/** What the fields hold: the route as a `routeKey`, the model, web search. */
export interface ReplyFieldValues {
  route: string;
  modelId: string;
  grounding: GroundingMode;
}

/** The fields as `branch` fills them. */
export function replyFieldsOf(branch: Branch): ReplyFieldValues {
  return {
    route: routeKey(branch),
    modelId: branch.model,
    grounding: branch.grounding ?? DEFAULT_GROUNDING_MODE,
  };
}

/** What saving `values` changes on `branch`: nothing it already has. */
export function replyChanges(branch: Branch, values: ReplyFieldValues): UpdateBranchRequest {
  const req: UpdateBranchRequest = {};
  if (values.grounding !== (branch.grounding ?? DEFAULT_GROUNDING_MODE)) {
    req.grounding = values.grounding;
  }
  const model = values.modelId.trim();
  if (values.route !== routeKey(branch) || model !== branch.model) {
    const { providerId, funding } = parseRouteKey(values.route);
    req.providerId = providerId;
    req.funding = funding;
    req.model = model;
  }
  return req;
}

/**
 * How a thread's replies are made: who pays and the model (`ModelPicker`),
 * and web search, which only some providers offer. Tangent settings edit a
 * tangent's, Conversation settings the main thread's.
 */
@Component({
  selector: 'app-reply-fields',
  imports: [ModelPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'reply-fields' },
  template: `
    @if (route()) {
      <app-model-picker [(route)]="route" [(modelId)]="modelId" />
    }

    @if (canSearch()) {
      <label class="field">
        <span class="field-label">Check facts with web search</span>
        <select #g [value]="grounding()" (change)="grounding.set(asGrounding(g.value))">
          <option value="auto" [selected]="grounding() === 'auto'">
            When a reply likely needs it (deep tangents, specific facts)
          </option>
          <option value="always" [selected]="grounding() === 'always'">
            Offer it on every reply
          </option>
          <option value="off" [selected]="grounding() === 'off'">
            Off (Check sources still works)
          </option>
        </select>
        <span class="muted small">
          The model decides whether to search, at most once per reply. A search costs about $0.007
          at OpenRouter, or $0.01 plus the results as input tokens at Anthropic. New tangents
          inherit this setting.
        </span>
      </label>
    } @else {
      <div class="field">
        <span class="field-label">Check facts with web search</span>
        <span class="muted small">
          This provider can't search the web. Pick an OpenRouter or Anthropic model to check facts;
          the setting is kept for when you do.
        </span>
      </div>
    }
  `,
})
export class ReplyFields {
  private readonly store = inject(TreeStore);
  /** Provider and funding, as a `routeKey`. */
  readonly route = model.required<string>();
  readonly modelId = model.required<string>();
  readonly grounding = model.required<GroundingMode>();

  protected readonly canSearch = computed(() => {
    const { providerId, funding } = parseRouteKey(this.route());
    return this.store.account
      .providers()
      .some(
        (p) => p.id === providerId && (p.funding ?? 'own-key') === funding && p.webSearch === true,
      );
  });

  protected asGrounding(value: string): GroundingMode {
    return GROUNDING_MODES.find((m) => m === value) ?? DEFAULT_GROUNDING_MODE;
  }
}
