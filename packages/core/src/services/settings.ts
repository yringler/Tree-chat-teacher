import {
  DEFAULT_REPLY_OUTPUT_TOKENS,
  REASONING_REPLY_OUTPUT_TOKENS,
  type ReasoningEffort,
} from '@tangent/shared';
import type { GroundingPolicy } from '../grounding/policy.js';

export interface ChatSettings {
  /**
   * Provider/model used for summaries and titles. null provider = use the
   * branch's own provider/model; null model = that provider's default model.
   */
  summaryProviderId: string | null;
  summaryModel: string | null;
  /**
   * Reasoning effort of summaries and titles (`GenerateRequest.reasoning`):
   * short outputs that need little thinking. null = the summary model's own
   * (its configured `ModelInfo.effort`, else the model's default).
   */
  summaryEffort: ReasoningEffort | null;
  /**
   * A reply's output cap (also reserved when computing the input budget) on a
   * model that doesn't reason. Default DEFAULT_REPLY_OUTPUT_TOKENS (4096).
   */
  reservedOutputTokens: number;
  /**
   * The same on a reasoning model (`ProviderCapabilities.reasoning`), whose
   * thinking counts as output. Default REASONING_REPLY_OUTPUT_TOKENS (16384).
   * Either is capped at the model's `maxOutputTokens`.
   */
  reasoningOutputTokens: number;
  /** Optional cap below the provider's context window (e.g. to save cost). */
  maxInputTokens: number | null;
  /** Generate a branch title after the first assistant reply. */
  autoTitle: boolean;
  /** Web-search grounding of replies: the operator's ceiling and the daily cap. */
  grounding: GroundingSettings;
}

export interface GroundingSettings {
  /** Operator ceiling over the per-branch setting; see GroundingPolicy. */
  policy: GroundingPolicy;
  /** Most searches per reply. */
  maxUses: number;
  /**
   * True when the per-branch setting is ignored and every branch counts as
   * `auto` (Learn: the pedagogy is the operator's, not the learner's).
   */
  ignoreBranchSetting: boolean;
}

export const DEFAULT_GROUNDING_SETTINGS: GroundingSettings = {
  policy: 'off',
  maxUses: 1,
  ignoreBranchSetting: false,
};

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  summaryProviderId: null,
  summaryModel: null,
  summaryEffort: null,
  reservedOutputTokens: DEFAULT_REPLY_OUTPUT_TOKENS,
  reasoningOutputTokens: REASONING_REPLY_OUTPUT_TOKENS,
  maxInputTokens: null,
  autoTitle: true,
  grounding: DEFAULT_GROUNDING_SETTINGS,
};

/**
 * What an app's ChatSettings take from the operator's configuration; every
 * other field keeps its default. The Worker reads them from its env, the
 * demos pass their own.
 */
export interface AppChatSettingsConfig extends Partial<
  Pick<
    ChatSettings,
    | 'summaryEffort'
    | 'maxInputTokens'
    | 'autoTitle'
    | 'reservedOutputTokens'
    | 'reasoningOutputTokens'
  >
> {
  summaryProviderId: string | null;
  summaryModel: string | null;
  /** The operator's ceiling over each branch's grounding setting (GROUNDING). */
  groundingPolicy: GroundingPolicy;
}

/**
 * The ChatSettings of a Learn or power account. Learn titles every
 * conversation and ignores each branch's grounding setting (every branch
 * counts as `auto`: the pedagogy is the operator's, not the learner's).
 */
export function appChatSettings(
  app: 'learn' | 'power',
  { groundingPolicy, ...config }: AppChatSettingsConfig,
): ChatSettings {
  return {
    ...DEFAULT_CHAT_SETTINGS,
    ...config,
    ...(app === 'learn' ? { autoTitle: true } : {}),
    grounding: {
      ...DEFAULT_GROUNDING_SETTINGS,
      policy: groundingPolicy,
      ignoreBranchSetting: app === 'learn',
    },
  };
}
