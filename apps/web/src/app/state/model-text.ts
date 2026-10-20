import { TIER_LABELS, TIERS, type ModelInfo, type ProviderInfo } from '@tangent/shared';
import { suggestionText, type SuggestionText } from '@tangent/web-shared';

/**
 * What a listed model is called in power, where "Normal" and "Max" name only
 * the user's tiers (TierStore `choice`): `suggestionText`, or its id where
 * the label only names a tier ("Max (suggested)" reads "claude-sonnet-5.5").
 */
export function modelText(m: ModelInfo): SuggestionText {
  const text = suggestionText(m);
  return TIERS.some((t) => TIER_LABELS[t] === text.name)
    ? { name: text.id ?? m.id, id: null }
    : text;
}

/** What model `id` is called on `provider` (`modelText`), or its id where it isn't listed. */
export function modelName(provider: Pick<ProviderInfo, 'models'> | undefined, id: string): string {
  const m = provider?.models.find((x) => x.id === id);
  return m ? modelText(m).name : id;
}
