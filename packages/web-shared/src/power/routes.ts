import {
  isModelAllowed,
  type Branch,
  type BranchFunding,
  type ProviderInfo,
} from '@tangent/shared';

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

/**
 * Why a route can't be picked, appended to its label; empty when it can: no
 * key, unavailable, or (`locked`, see `PowerAccountStore.routeLocked`) a
 * funding that needs the membership the user lacks.
 */
export function routeSuffix(p: ProviderInfo, locked: boolean): string {
  if (p.available) return locked ? ' — needs a membership' : '';
  return p.acceptsUserKey ? ' — missing API key' : ' — unavailable';
}

/**
 * The route and model a new branch starts on: its parent's, unless that one
 * can't generate here (`parentUsable` false: its funding needs the
 * membership the user lacks, or its own key isn't saved in this browser);
 * then `fallback`, the default route of a new conversation, keeping the
 * parent's model where that route serves it. No fallback either: an empty
 * route, which nothing can be sent on.
 */
export function startingRoute(
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
