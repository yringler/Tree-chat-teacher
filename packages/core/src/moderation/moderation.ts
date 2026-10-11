// Publish-time screening of what a share would make public. Pure: the
// classifier is a `ModerationProvider` the Worker supplies, and this module
// only splits the text, asks it and turns the scores into a verdict.

/** The categories a classifier scores, each 0..1. */
export const MODERATION_CATEGORIES = [
  'sexual',
  'sexual/minors',
  'harassment',
  'harassment/threatening',
  'hate',
  'hate/threatening',
  'illicit',
  'illicit/violent',
  'self-harm',
  'self-harm/intent',
  'self-harm/instructions',
  'violence',
  'violence/graphic',
] as const;

export type ModerationCategory = (typeof MODERATION_CATEGORIES)[number];

export type CategoryScores = Readonly<Record<ModerationCategory, number>>;

/** Classifies each input; resolves one score set per input, in order, or throws. */
export interface ModerationProvider {
  classify(inputs: readonly string[]): Promise<readonly CategoryScores[]>;
}

export type ModerationVerdict =
  | { readonly kind: 'allow'; readonly maxScores: CategoryScores }
  | {
      readonly kind: 'block';
      readonly reasons: readonly ModerationCategory[];
      readonly maxScores: CategoryScores;
    }
  | { readonly kind: 'csam_flag'; readonly maxScores: CategoryScores }
  /** More text than one publish may send; nothing was classified. */
  | { readonly kind: 'too_long' }
  | { readonly kind: 'error'; readonly message: string };

/** At or above these, publishing is refused. Tune them from the logged scores. */
export const BLOCK_THRESHOLDS: Readonly<Partial<Record<ModerationCategory, number>>> = {
  'illicit/violent': 0.5,
  violence: 0.8,
  'self-harm/instructions': 0.5,
  'hate/threatening': 0.5,
  'harassment/threatening': 0.6,
};

/**
 * `sexual/minors` at or above this refuses and flags the share for the CSAM
 * procedure. Deliberately low: a false positive costs a person's review, a
 * miss puts the material online.
 */
export const CSAM_THRESHOLD = 0.1;

/** Inputs per classifier call. */
export const MODERATION_BATCH_SIZE = 32;
/** The longest input sent; longer texts are split, so every character is screened. */
export const MODERATION_PIECE_CHARS = 8_000;
/** The most text one publish screens; beyond it the owner shares a part instead. */
export const MODERATION_MAX_CHARS = 400_000;

const ZERO: CategoryScores = {
  sexual: 0,
  'sexual/minors': 0,
  harassment: 0,
  'harassment/threatening': 0,
  hate: 0,
  'hate/threatening': 0,
  illicit: 0,
  'illicit/violent': 0,
  'self-harm': 0,
  'self-harm/intent': 0,
  'self-harm/instructions': 0,
  violence: 0,
  'violence/graphic': 0,
};

/** The highest score of each category across `scores`. */
export function maxScoresOf(scores: readonly CategoryScores[]): CategoryScores {
  const out: Record<ModerationCategory, number> = { ...ZERO };
  for (const s of scores) {
    for (const c of MODERATION_CATEGORIES) out[c] = Math.max(out[c], s[c]);
  }
  return out;
}

/** The decision for a publish whose texts scored at most `maxScores`. */
export function verdictOf(maxScores: CategoryScores): ModerationVerdict {
  if (maxScores['sexual/minors'] >= CSAM_THRESHOLD) return { kind: 'csam_flag', maxScores };
  const reasons = MODERATION_CATEGORIES.filter((c) => {
    const threshold = BLOCK_THRESHOLDS[c];
    return threshold !== undefined && maxScores[c] >= threshold;
  });
  return reasons.length > 0 ? { kind: 'block', reasons, maxScores } : { kind: 'allow', maxScores };
}

/** `texts` without blank ones, each cut into pieces of at most `MODERATION_PIECE_CHARS`. */
function pieces(texts: readonly string[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    if (!text.trim()) continue;
    for (let i = 0; i < text.length; i += MODERATION_PIECE_CHARS) {
      out.push(text.slice(i, i + MODERATION_PIECE_CHARS));
    }
  }
  return out;
}

/**
 * Screens `texts` with `provider`, in batches of `MODERATION_BATCH_SIZE`
 * sent at once, and decides from the highest score of each category. Never
 * throws: a provider failure, or an answer with the wrong number of results,
 * is an `error` verdict, which the caller refuses on (fail closed).
 */
export async function moderateTexts(
  provider: ModerationProvider,
  texts: readonly string[],
): Promise<ModerationVerdict> {
  if (texts.reduce((n, t) => n + t.length, 0) > MODERATION_MAX_CHARS) return { kind: 'too_long' };
  const inputs = pieces(texts);
  const batches: string[][] = [];
  for (let i = 0; i < inputs.length; i += MODERATION_BATCH_SIZE) {
    batches.push(inputs.slice(i, i + MODERATION_BATCH_SIZE));
  }
  try {
    const results = await Promise.all(
      batches.map(async (batch) => {
        const scores = await provider.classify(batch);
        if (scores.length !== batch.length) {
          throw new Error(`Expected ${batch.length} results, got ${scores.length}`);
        }
        return scores;
      }),
    );
    return verdictOf(maxScoresOf(results.flat()));
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}
