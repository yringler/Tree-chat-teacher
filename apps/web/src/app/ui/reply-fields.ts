import { ChangeDetectionStrategy, Component, computed, inject, model } from '@angular/core';
import {
  DEFAULT_GROUNDING_MODE,
  GROUNDING_MODES,
  joinList,
  parseRouteKey,
  routeKey,
  type Branch,
  type GroundingMode,
  type UpdateBranchRequest,
} from '@tangent/shared';
import { TreeStore } from '../state/tree-store';
import { ModelPicker } from './model-picker';

let uid = 0;

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

/** Replies on `route` (a `routeKey`) can search the web: its provider entry offers it. */
export function routeSearches(store: TreeStore, route: string): boolean {
  return store.account.providerMap().get(route)?.webSearch === true;
}

/** Web search in a few words, as a one-line summary of a thread's replies puts it. */
export function searchSummary(grounding: GroundingMode, canSearch: boolean): string {
  if (!canSearch || grounding === 'off') return 'no web search';
  return grounding === 'always' ? 'search offered on every reply' : 'search when likely needed';
}

/**
 * How a thread's replies are made: who pays and the model (`ModelPicker`),
 * and web search, which only some providers offer. Tangent settings edit a
 * tangent's, Conversation settings the main thread's, and Tangent from here
 * a new tangent's. What a search costs stays in view; the exact prices are
 * one click away.
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

    <div class="field">
      @if (canSearch()) {
        <label class="field-label" [for]="id + '-g'">Web search</label>
        <select
          #g
          [id]="id + '-g'"
          [attr.aria-describedby]="id + '-gh'"
          [value]="grounding()"
          (change)="grounding.set(asGrounding(g.value))"
        >
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
        <span class="muted small" [id]="id + '-gh'">
          About 1¢ a search, plus the results as input tokens, paid like the reply. The model
          decides whether to search, at most once a reply.
        </span>
        <details class="more-details">
          <summary>Web search prices</summary>
          <p>
            At OpenRouter, about $0.007 a search; at Anthropic, $0.01. On Tangent credit, the same
            as the provider that answers.
          </p>
        </details>
      } @else {
        <span class="field-label">Web search</span>
        <span class="muted small">{{ cantSearch() }}</span>
      }
    </div>
  `,
})
export class ReplyFields {
  private readonly store = inject(TreeStore);
  /** Provider and funding, as a `routeKey`. */
  readonly route = model.required<string>();
  readonly modelId = model.required<string>();
  readonly grounding = model.required<GroundingMode>();
  protected readonly id = `rf${++uid}`;

  protected readonly canSearch = computed(() => routeSearches(this.store, this.route()));

  /** Names the entries that can search, from the providers this server offers. */
  protected readonly cantSearch = computed(() => {
    const labels = this.store.account
      .providers()
      .filter((p) => p.webSearch === true)
      .map((p) => p.label);
    const can = joinList([...new Set(labels)], 'and');
    return can
      ? `This provider can't search the web; ${can} can. Your choice is kept for when you switch.`
      : "This provider can't search the web.";
  });

  protected asGrounding(value: string): GroundingMode {
    return GROUNDING_MODES.find((m) => m === value) ?? DEFAULT_GROUNDING_MODE;
  }
}
