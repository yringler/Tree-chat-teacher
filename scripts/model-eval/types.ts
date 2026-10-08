/** Shapes of the eval's inputs (questions, configs) and outputs (results). */

/** One user turn of a conversation, possibly in a new branch. */
export interface TurnSpec {
  /** Unique within the item; a later turn's `parent` names it. */
  readonly id: string;
  /** The turn this one follows (its answer is the last history message); none for the first. */
  readonly parent?: string;
  readonly question: string;
  /**
   * The excerpt the user highlighted when branching (the branch's anchor quote).
   * Rendered as production does, per the config's `anchorMode`.
   */
  readonly anchor?: string;
  /**
   * A recorded reply to use as this turn's answer in later turns' history
   * (`history: "fixed"`), so every config sees the same path. Without it the
   * config's own answer is used.
   */
  readonly assistant?: string;
  readonly expected?: string;
}

/** One question, or a conversation (a tree of turns) when `turns` is set. */
export interface QuestionItem {
  readonly id: string;
  readonly category: string;
  /** Single-turn question (exactly one of `question` / `turns`). */
  readonly question?: string;
  readonly turns?: readonly TurnSpec[];
  /** What a correct answer says (for the grader); `final` answers for maths. */
  readonly expected?: string;
  /** Grader hints: e.g. "fictitious: should say it can't confirm". */
  readonly notes?: string;
  /** Named subsets, selected with `--subset` or a config's `subset`. */
  readonly tags?: readonly string[];
}

export interface QuestionFile {
  /** Defaults to Tangent's DEFAULT_SYSTEM_PROMPT. */
  readonly systemPrompt?: string;
  readonly items: readonly QuestionItem[];
}

/**
 * OpenRouter `reasoning.effort` values. "off" sends `reasoning: {enabled: false}`;
 * null omits the field (the model's default).
 */
export type Effort = 'off' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Where a branch's anchor quote goes: quoted into the user turn as an
 * `<excerpt>` (what `renderPlan` does for every tier now, the default), or
 * appended to the system prompt (the old Learn rendering, kept to measure how
 * much prompt caching it cost: every new excerpt changes the system prompt).
 */
export type AnchorMode = 'system' | 'user';

export interface EvalConfig {
  readonly label: string;
  readonly model: string;
  readonly effort: Effort | null;
  /** `max_tokens`: reasoning and answer combined. */
  readonly maxTokens: number;
  /** `provider.order`; omit for OpenRouter's default routing. */
  readonly providerOrder?: readonly string[];
  /** `provider.allow_fallbacks` when `providerOrder` is set (default true). */
  readonly allowFallbacks?: boolean;
  /** Default "user". */
  readonly anchorMode?: AnchorMode;
  /** Run only items carrying this tag. */
  readonly subset?: string;
  /** Merged into the request body last (e.g. `{"verbosity": "low"}`). */
  readonly extraBody?: Readonly<Record<string, unknown>>;
}

/** Usage of one call, from OpenRouter's usage accounting. */
export interface CallUsage {
  promptTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  /** USD, as billed. */
  cost: number;
}

export interface CallResult {
  /** `${itemId}#${turnId}` (turn id "q" for single questions). */
  readonly key: string;
  readonly itemId: string;
  readonly turnId: string;
  /** Position of the turn on its path (1 = no history). */
  readonly depth: number;
  readonly config: string;
  readonly model: string;
  readonly startedAt: string;
  provider: string | null;
  finishReason: string | null;
  answer: string;
  usage: CallUsage | null;
  latencyMs: number;
  /** Time to the first answer (not reasoning) token. */
  firstAnswerMs: number | null;
  generationId: string | null;
  error: string | null;
}
