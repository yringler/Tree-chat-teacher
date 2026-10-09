import type { DefaultRouteFacts, ProviderRegistry } from '@tangent/shared';
import type { TokenEstimator } from '../tokens.js';

/**
 * Which product a ChatService instance serves, and what that changes about
 * its routes and generations.
 */
export type GenerationProfile = PowerProfile | LearnProfile | PoolProfile;

/** Power: a branch's funding says who pays, the user's own key or Tangent credit. */
export interface PowerProfile {
  kind: 'power';
  /** Tangent credit, where the server offers it: a branch on credit has no provider otherwise. */
  credit?: {
    /** The providers of `credit` routes: the built-in endpoint on the operator's key, metered. */
    providers: ProviderRegistry;
    /**
     * What the default route of a new tree needs beyond the provider lists
     * (`pickDefaultRoute`): whether Tangent credit can pay now and whether
     * own keys need a membership the user lacks. Asked only for a new tree
     * that names neither a provider nor a funding. Absent: credit can't pay
     * and nothing is locked, so a new tree never defaults onto credit.
     */
    defaultRouteFacts?: () => Promise<DefaultRouteFacts>;
  };
}

/**
 * Learn: how a request pays is decided per request, outside the branch, so
 * every route comes from `ChatServiceDeps.providers` whatever a branch's
 * funding, provider or model says (`RouteResolver.runnable`), and every
 * branch this instance writes is `own-key`. Imported
 * backups are adapted to what Learn can show and continue
 * (`adaptBackupForLearn`): onto that registry's default provider and its
 * models, `path` context, and the prompt a new tree gets.
 */
export interface LearnProfile {
  kind: 'learn';
  /**
   * The tree's learner instructions are added after Learn's tutor prompt
   * (`ChatServiceDeps.defaultSystemPrompt`), which is always sent: true where
   * the learner pays with their own key or credit, false on the pool.
   */
  customPrompt: boolean;
}

/**
 * Learn on the open pool: as Learn, and every generation runs under the
 * pool's restrictions. The tree and branch rows are not changed.
 */
export interface PoolProfile {
  kind: 'pool';
  /**
   * The one model every generation uses (replies, budgets, summaries and
   * titles without a configured summary model), whatever the branch says.
   */
  model: string;
  /** The system prompt every generation uses instead of the tree's own. */
  systemPrompt: string;
  /**
   * Makes the input budget a hard bound: context budgets are measured with
   * this instead of the default chars/3.5, and every summary prompt is
   * clipped to the summary model's input budget, measured the same way, so
   * no request exceeds it.
   */
  estimateTokens: TokenEstimator;
  /**
   * The longest anchor quote generations use, in UTF-16 units (`.length`, as
   * the message limit counts); longer ones are clipped (the quote is client-set
   * free text, so it gets no more room than a message).
   */
  anchorQuoteMaxChars: number;
}

/** Whether `profile` decides payment per request (Learn, with or without the pool). */
export function paysPerRequest(profile: GenerationProfile): profile is LearnProfile | PoolProfile {
  return profile.kind !== 'power';
}
