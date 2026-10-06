import type { GroundingMode } from '@tangent/shared';

/**
 * Operator-level grounding policy (the Worker's `GROUNDING` var), a ceiling
 * over the per-branch setting:
 * - `auto`: offer web search on turns the gate below picks; the model decides;
 * - `always-offer`: offer it on every turn; the model decides;
 * - `explicit`: only when the learner asks ("Check sources");
 * - `off`: never.
 */
export type GroundingPolicy = 'auto' | 'always-offer' | 'explicit' | 'off';
export const GROUNDING_POLICIES: readonly GroundingPolicy[] = [
  'auto',
  'always-offer',
  'explicit',
  'off',
];

export interface GroundingInput {
  policy: GroundingPolicy;
  /** The branch's own setting (power mode); Learn passes `auto`. */
  branchMode: GroundingMode;
  /** The send asked for a search ("Check sources"). */
  explicit: boolean;
  /** The provider/model can search (`ProviderCapabilities.supportsWebSearch`). */
  supported: boolean;
  /** False once the daily automatic-search cap is reached (credit only). */
  autoAllowed: boolean;
  /** Branch depth: 0 for the trunk, 1 for a branch of it, … */
  depth: number;
  /** The new user message. */
  userText: string;
  /** The context replaced part of the conversation by a summary. */
  lossyContext: boolean;
}

export interface GroundingDecision {
  /** `none`: no search; `auto`: offer it, the model decides; `required`: must search. */
  mode: 'none' | 'auto' | 'required';
  score: number;
  /** Why (for logs and tests). */
  reasons: string[];
}

/** Score at which a turn is offered web search under the `auto` policy. */
export const GROUNDING_THRESHOLD = 2;

const FACT =
  /\b(1[0-9]{3}|20[0-9]{2})\b|\b\d[\d,.]*\s?(%|°|(percent|km|kg|mph|degrees|million|billion|years?|meters?|miles?)\b)|\b(how many|how much|when did|when was|what year|who (invented|discovered|said|wrote|founded|first|coined|proved))\b/i;
const RECENCY =
  /\b(latest|current(ly)?|recent(ly)?|today|nowadays|this year|as of|still|newest|up[- ]to[- ]date)\b/i;
const SOURCES =
  /\b(sources?|cite|citations?|references?|stud(y|ies)|papers?|evidence|quotes?|quotation|according to)\b/i;
const CONCEPTUAL =
  /^\s*(why|how does|how do|how is|explain|what is the intuition|what's the intuition|intuitively)\b/i;

/** Capitalized words not at the start of a sentence (rough named-entity count). */
function namedEntityCount(text: string): number {
  let count = 0;
  for (const sentence of text.split(/(?<=[.!?:])\s+|\n+/)) {
    const words = sentence.trim().split(/\s+/).slice(1);
    for (const w of words) {
      const word = w.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
      if (word.length > 1 && /^\p{Lu}/u.test(word) && word !== 'I') count++;
    }
  }
  return count;
}

/** The free, deterministic score: how likely this turn needs facts the model may misremember. */
export function groundingScore(
  input: Pick<GroundingInput, 'depth' | 'userText' | 'lossyContext'>,
): {
  score: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  let score = 0;
  const add = (points: number, reason: string) => {
    score += points;
    reasons.push(`${reason} ${points > 0 ? '+' : ''}${points}`);
  };
  if (input.depth >= 2) add(2, 'deep tangent');
  else if (input.depth === 1) add(1, 'tangent');
  const text = input.userText;
  const fact = FACT.test(text);
  if (fact) add(2, 'specific fact');
  if (RECENCY.test(text)) add(2, 'recency');
  if (SOURCES.test(text)) add(2, 'sources asked');
  if (namedEntityCount(text) >= 2) add(1, 'named entities');
  if (input.lossyContext) add(1, 'summarized context');
  if (!fact && CONCEPTUAL.test(text)) add(-1, 'conceptual');
  return { score, reasons };
}

/**
 * Whether to offer (or require) web search for one reply. Pure: the caller
 * supplies depth, capability and the cap. Summaries, titles and reviews never
 * search; only replies go through here.
 */
export function decideGrounding(input: GroundingInput): GroundingDecision {
  const none = (reason: string): GroundingDecision => ({
    mode: 'none',
    score: 0,
    reasons: [reason],
  });
  if (!input.supported) return none('provider cannot search');
  if (input.policy === 'off') return none('policy off');
  if (input.explicit) return { mode: 'required', score: 0, reasons: ['check sources'] };
  if (input.policy === 'explicit') return none('policy explicit');
  if (input.branchMode === 'off') return none('branch off');
  if (!input.autoAllowed) return none('daily cap');
  if (input.policy === 'always-offer' || input.branchMode === 'always') {
    return { mode: 'auto', score: 0, reasons: ['always offer'] };
  }
  const { score, reasons } = groundingScore(input);
  return { mode: score >= GROUNDING_THRESHOLD ? 'auto' : 'none', score, reasons };
}
