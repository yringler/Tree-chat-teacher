import {
  OPENROUTER_PROVIDER_ID,
  clip,
  formatTangents,
  REVIEW_ACCURACY_LABEL,
  REVIEW_RECOMMENDATION_LABEL,
  type Citation,
  type GenerateRequest,
  LlmProvider,
  ModelInfo,
  ProviderCapabilities,
  ProviderEvent,
  type Tangent,
  type TokenPrice,
} from '@tangent/shared';
import { getAdjectives, getNouns, sentence as txtSentence, setRandom, setTemplates } from 'txtgen';

/*
 * "Fun lorem ipsum" for the demo: English-ish nonsense from txtgen, shaped
 * like a Learn reply (short paragraphs, sometimes a list or a bold phrase,
 * ending with a `<tangents>` block of places to go next). Nothing here
 * calls a model.
 */

// txtgen ships `setRandom` but its typings omit it.
declare module 'txtgen' {
  export function setRandom(random: () => number): void;
}

export type Random = () => number;

/**
 * txtgen 3 ships a single sentence template ("however, {{nouns}} have begun
 * to rent {{nouns}}..."), so the demo brings its own, tutor-flavoured ones
 * (txtgen syntax: noun, a_noun, nouns, adjective, an_adjective).
 */
const SENTENCE_TEMPLATES: readonly string[] = [
  'the {{noun}} is {{an_adjective}} {{noun}} in disguise',
  '{{nouns}} learn fastest when {{a_noun}} explains them to {{a_noun}}',
  'every {{adjective}} {{noun}} starts out as {{a_noun}} with a question',
  'a good way to remember this is to picture {{a_noun}} juggling {{nouns}}',
  'in short, {{nouns}} are just {{adjective}} {{nouns}} with better manners',
  'think of {{a_noun}} as {{an_adjective}} {{noun}} that never stops asking why',
  'the trick is that {{nouns}} only look {{adjective}} from far away',
  'most {{nouns}} would agree that {{a_noun}} is {{an_adjective}} kind of {{noun}}',
  'if you follow {{a_noun}} long enough, it turns into {{an_adjective}} {{noun}}',
  'historians still argue whether the first {{noun}} was {{adjective}} or merely {{adjective}}',
  'the key idea is that {{nouns}} and {{nouns}} share the same {{adjective}} logic',
  '{{a_noun}} is to {{a_noun}} what {{a_noun}} is to {{a_noun}}',
  'this is why {{adjective}} {{nouns}} rarely argue with {{nouns}}',
  'scientists once measured {{a_noun}} and found it surprisingly {{adjective}}',
  'you can test this at home with {{a_noun}}, {{a_noun}} and a little patience',
  'the textbook answer involves {{nouns}}, but the fun answer involves {{nouns}}',
  'notice how {{a_noun}} becomes {{adjective}} as soon as {{a_noun}} walks in',
  'in other words, {{a_noun}} is never just {{a_noun}}',
  'some people call this the {{adjective}} {{noun}} effect',
  'the pattern repeats: first {{nouns}}, then {{nouns}}, then {{an_adjective}} surprise',
  'nobody expects {{a_noun}} to be {{adjective}}, and that is exactly the point',
  'step one is to imagine {{an_adjective}} {{noun}}; step two is to ask it nicely',
  'it helps to compare {{nouns}} with {{nouns}} and see which one blinks first',
  'a common mistake is to treat {{a_noun}} like {{an_adjective}} {{noun}}',
  'once you see {{nouns}} this way, {{nouns}} start to make sense too',
];
setTemplates([...SENTENCE_TEMPLATES]);

/** One txtgen sentence (its "by the way" opener lacks a comma and a space). */
function sentence(): string {
  return txtSentence()
    .replace(/^By the way(?=\S)/, 'By the way, ')
    .replace(/;$/, '.');
}

/**
 * The demo provider's models, on the real built-in provider's endpoint
 * (`OPENROUTER_PROVIDER_ID`): Normal (the default) and Max.
 */
export const DEMO_NORMAL_MODEL = 'normal';
export const DEMO_MAX_MODEL = 'max';
export const DEMO_MODELS: readonly ModelInfo[] = [
  { id: DEMO_NORMAL_MODEL, label: 'Normal', tier: 'normal' },
  { id: DEMO_MAX_MODEL, label: 'Max', tier: 'max' },
];

/**
 * Pretend list prices (micro-dollars per million tokens): the default tiers'
 * real prices (V4.1 Flash and Sonnet 5.5), so the demo's Max note says what
 * the app's does, about 14× Normal.
 */
export const DEMO_MODEL_PRICES: Readonly<Record<string, TokenPrice>> = {
  [DEMO_NORMAL_MODEL]: { inMicrosPerMTok: 150_000, outMicrosPerMTok: 600_000 },
  [DEMO_MAX_MODEL]: { inMicrosPerMTok: 2_000_000, outMicrosPerMTok: 10_000_000 },
};

/** A small deterministic RNG (mulberry32), for tests and reproducible demos. */
export function seededRandom(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Runs `fn` with txtgen drawing from `random` (txtgen keeps one global RNG). */
function withRandom<T>(random: Random, fn: () => T): T {
  setRandom(random);
  try {
    return fn();
  } finally {
    setRandom(Math.random);
  }
}

function pick<T>(random: Random, list: readonly T[]): T {
  return list[Math.floor(random() * list.length) % list.length] as T;
}

function between(random: Random, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

function article(word: string): string {
  return /^(a|e|i|o|u|heir|herb|hour)/i.test(word) ? `an ${word}` : `a ${word}`;
}

function plural(word: string): string {
  if (word.endsWith('s')) return word;
  if (/(ss|sh|ch|x|us)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

interface Words {
  noun: string;
  noun2: string;
  adjective: string;
}

function words(random: Random): Words {
  const nouns = getNouns();
  const noun = pick(random, nouns);
  let noun2 = pick(random, nouns);
  if (noun2 === noun) noun2 = pick(random, nouns);
  return { noun, noun2, adjective: pick(random, getAdjectives()) };
}

const TANGENTS: readonly ((w: Words) => Tangent)[] = [
  (w) => ({
    title: `Why ${plural(w.noun)} are ${w.adjective}`,
    why: `the mechanism underneath, one layer down`,
  }),
  (w) => ({
    title: `What happens when ${article(w.noun)} meets ${article(w.noun2)}`,
    why: `the same idea in a different place`,
  }),
  (w) => ({
    title: `The ${w.adjective} ${w.noun} misconception`,
    why: `where the simple picture breaks`,
  }),
  (w) => ({
    title: `How ${plural(w.noun)} got their name`,
    why: `the history is better than it sounds`,
  }),
  (w) => ({
    title: `${capitalize(plural(w.noun))} versus ${plural(w.noun2)}`,
    why: `an edge case that shows what the rule is really about`,
  }),
  (w) => ({
    title: `Is ${article(w.noun)} ever ${w.adjective}?`,
    why: `a question that is still open`,
  }),
];

const OPENERS: readonly ((w: Words) => string)[] = [
  (w) => `Because of **${article(w.adjective)} ${w.noun}**.`,
  (w) => `It comes down to **${article(w.noun)}**.`,
  () => 'In short: yes, and the reason is the interesting part.',
  (w) => `Think of it as **${article(w.noun)}** with a job to do.`,
  () => 'Mostly, but not always.',
];

/** Two to four suggested tangents, built from templates and txtgen words (no two alike). */
export function loremTangents(random: Random = Math.random): Tangent[] {
  const out: Tangent[] = [];
  const used = new Set<number>();
  const count = between(random, 2, 4);
  while (out.length < count && used.size < TANGENTS.length) {
    const i = Math.floor(random() * TANGENTS.length) % TANGENTS.length;
    if (used.has(i)) continue;
    used.add(i);
    out.push(TANGENTS[i]!(words(random)));
  }
  return out;
}

function sentences(random: Random, count: number): string {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(sentence());
  return out.join(' ');
}

/** Bolds two words somewhere inside a sentence (punctuation stays outside the stars). */
function boldSome(random: Random, text: string): string {
  const parts = text.split(' ');
  if (parts.length < 6) return text;
  const start = between(random, 1, parts.length - 3);
  const run = parts.slice(start, start + 2).join(' ');
  const punct = /[.,;:!?]+$/.exec(run)?.[0] ?? '';
  parts.splice(start, 2, `**${run.slice(0, run.length - punct.length)}**${punct}`);
  return parts.join(' ');
}

/**
 * A Learn-shaped reply in Markdown: 1–3 short paragraphs (Max writes
 * more), sometimes a bulleted list or a bold phrase, always ending
 * with a `<tangents>` block (the prompt's format; the app turns it into
 * branch buttons).
 */
export function loremReply(model: string, random: Random = Math.random): string {
  return withRandom(random, () => {
    const max = model !== DEMO_NORMAL_MODEL;
    const paragraphs: string[] = [];
    const count = max ? between(random, 2, 3) : between(random, 1, 2);
    for (let i = 0; i < count; i++) {
      let p = sentences(random, max ? between(random, 2, 4) : between(random, 1, 3));
      if (i === 0 && random() < 0.5) p = `${pick(random, OPENERS)(words(random))} ${p}`;
      else if (random() < 0.35) p = boldSome(random, p);
      paragraphs.push(p);
    }
    if (random() < (max ? 0.5 : 0.3)) {
      const items: string[] = [];
      for (let i = between(random, 2, max ? 4 : 3); i > 0; i--) {
        const w = words(random);
        items.push(`- **${capitalize(plural(w.noun))}**: ${sentence()}`);
      }
      paragraphs.splice(Math.min(1, paragraphs.length), 0, items.join('\n'));
    }
    paragraphs.push(formatTangents(loremTangents(random)));
    return paragraphs.join('\n\n');
  });
}

/** A short lesson / side-question title, e.g. "Courageous kangaroos and the plum". */
export function loremTitle(random: Random = Math.random): string {
  return withRandom(random, () => {
    const w = words(random);
    const forms = [
      `${capitalize(w.adjective)} ${plural(w.noun)} and the ${w.noun2}`,
      `Why ${plural(w.noun)} feel ${w.adjective}`,
      `The ${w.adjective} ${w.noun}`,
      `${capitalize(plural(w.noun))} versus ${plural(w.noun2)}`,
    ];
    return pick(random, forms);
  });
}

const TITLE_WORDS = 6;
const TITLE_CHARS = 48;

/**
 * The title for a title request: the first words of what the learner asked,
 * so that a lesson on "Why is the sky blue?" is called that and not
 * "Cheetahs versus flies". The ChatService's title prompt wraps the first
 * messages as "User: …" / "Assistant: …" lines (core/context/render.ts);
 * a side question's quote comes first as "User: Focus: …" and is skipped.
 * Falls back to a random title when no learner message can be found.
 */
export function titleFor(messages: readonly { content: string }[], random: Random): string {
  for (const m of messages) {
    for (const match of m.content.matchAll(/^User: (.+)$/gm)) {
      const line = match[1]?.trim() ?? '';
      if (!line || line.startsWith('Focus: ')) continue;
      const words = line.replace(/\s+/g, ' ').split(' ');
      const title = clip(words.slice(0, TITLE_WORDS).join(' '), TITLE_CHARS);
      return words.length > TITLE_WORDS && !title.endsWith('…') ? `${title}…` : title;
    }
  }
  return loremTitle(random);
}

const REVIEW_VERDICTS: readonly [accuracy: string, recommendation: string][] = [
  ['OK', 'STAY'],
  ['MINOR', 'STAY'],
  ['MINOR', 'UPGRADE'],
  ['MAJOR', 'UPGRADE'],
];

/**
 * A review-shaped reply for "Review up to here": the Corrections and
 * Assessment sections the real prompt asks for (core/context/render.ts) and
 * the two verdict lines its parser reads, so the demo shows the verdict
 * badges and the follow-up actions a real review would.
 */
export function loremReview(random: Random = Math.random): string {
  return withRandom(random, () => {
    const [accuracy, recommendation] = pick(random, REVIEW_VERDICTS);
    const corrections: string[] = [];
    if (accuracy !== 'OK') {
      for (let i = between(random, 1, accuracy === 'MAJOR' ? 3 : 2); i > 0; i--) {
        const w = words(random);
        corrections.push(
          `${corrections.length + 1}. The reply calls the ${w.noun} ${w.adjective}; ${sentence()}`,
        );
      }
    }
    const assessment =
      recommendation === 'UPGRADE'
        ? `${capitalize(sentence())} A more capable model would handle the ${words(random).noun} better.`
        : `${capitalize(sentence())} The current model is handling this well.`;
    return [
      '## Corrections',
      corrections.length ? corrections.join('\n') : 'No errors found.',
      '## Assessment',
      assessment,
      `${REVIEW_ACCURACY_LABEL}: ${accuracy}\n${REVIEW_RECOMMENDATION_LABEL}: ${recommendation}`,
    ].join('\n\n');
  });
}

/** A paragraph standing in for a conversation summary. */
export function loremSummary(random: Random = Math.random): string {
  return withRandom(random, () => sentences(random, between(random, 3, 5)));
}

// ---------------------------------------------------------------- provider

export interface LoremProviderOptions {
  random?: Random;
  /** Pause between streamed words (default 20–40 ms). */
  minDelayMs?: number;
  maxDelayMs?: number;
  /** Injected for tests; must resolve early (or reject) when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Waits `ms`, or until `signal` aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

const CAPABILITIES: ProviderCapabilities = {
  maxContextTokens: 200_000,
  maxOutputTokens: 4096,
  supportsSystemPrompt: true,
  supportsTokenCount: false,
  supportsWebSearch: true,
  requiredWebSearch: true,
  titles: true,
};

/** Pretend web search fee per search (USD), like OpenRouter's Exa search. */
const FAKE_SEARCH_USD = 0.007;

/** Pretend sources on example domains (never a real site). */
function loremCitations(random: Random): Citation[] {
  const hosts = ['example.org', 'example.com', 'example.net'];
  return withRandom(random, () =>
    Array.from({ length: between(random, 2, 4) }, (_, i) => {
      const noun = pick(random, getNouns());
      const adjective = pick(random, getAdjectives());
      return {
        url: `https://${hosts[i % hosts.length]}/lorem/${noun.replace(/\s+/g, '-')}-${i + 1}`,
        title: capitalize(`${adjective} ${plural(noun)}`),
        excerpt: sentence(),
      };
    }),
  );
}

/** Rough token count (4 characters per token), like the fake provider. */
function tokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Pretend price in USD (DEMO_MODEL_PRICES plus a base): a few thousandths of a dollar per reply. */
function fakeCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const max = model !== DEMO_NORMAL_MODEL;
  const price = DEMO_MODEL_PRICES[max ? DEMO_MAX_MODEL : DEMO_NORMAL_MODEL]!;
  const base = max ? 0.002 : 0.001;
  return (
    base + (inputTokens * price.inMicrosPerMTok + outputTokens * price.outMicrosPerMTok) / 1e12
  );
}

/**
 * An LlmProvider that "generates" lorem replies word by word. Requests for
 * titles, summaries and reviews (by `usageTag.purpose`) get a title, a
 * paragraph or a review with a verdict.
 * Follows the provider contract: never throws, ends with exactly one
 * `done` or `error` (`aborted` when the signal fires), reports `usage` and a
 * `billing` cost so the demo's balance moves.
 * Its replies are scripted (kind `fake`), but its titles name the
 * conversation, so it keeps the `titles` capability and branches get titled.
 */
export function createLoremProvider(options: LoremProviderOptions = {}): LlmProvider {
  const random = options.random ?? Math.random;
  const minDelay = options.minDelayMs ?? 20;
  const maxDelay = Math.max(minDelay, options.maxDelayMs ?? 40);
  const sleep = options.sleep ?? abortableSleep;

  const textFor = (request: GenerateRequest): string => {
    switch (request.usageTag?.purpose) {
      case 'title':
        return titleFor(request.messages, random);
      case 'summary':
        return loremSummary(random);
      case 'review':
        return loremReview(random);
      default:
        return loremReply(request.model, random);
    }
  };

  async function* stream(request: GenerateRequest): AsyncGenerator<ProviderEvent> {
    const aborted = (): ProviderEvent => ({
      type: 'error',
      error: { code: 'aborted', message: 'Cancelled', retryable: false },
    });
    try {
      const text = textFor(request);
      let input = request.system ?? '';
      for (const m of request.messages) input += m.content;
      const inputTokens = tokens(input);
      // Titles and summaries are not streamed to anyone: no need to dawdle.
      const purpose = request.usageTag?.purpose ?? 'reply';
      const streamed = purpose === 'reply' || purpose === 'review';
      // "The model decides": a required search always runs, an offered one most of the time.
      const searched =
        request.webSearch !== undefined &&
        (request.webSearch.mode === 'required' || random() < 0.7);
      if (searched) {
        yield { type: 'activity', kind: 'web_search' };
        await sleep(400, request.signal);
      }
      for (const word of text.match(/\S+\s*/g) ?? []) {
        if (request.signal.aborted) {
          yield aborted();
          return;
        }
        if (streamed) await sleep(minDelay + random() * (maxDelay - minDelay), request.signal);
        if (request.signal.aborted) {
          yield aborted();
          return;
        }
        yield { type: 'delta', text: word };
      }
      const outputTokens = tokens(text);
      yield { type: 'usage', usage: { inputTokens, outputTokens } };
      if (searched) yield { type: 'citations', citations: loremCitations(random) };
      yield {
        type: 'billing',
        costUsd:
          fakeCostUsd(request.model, inputTokens, outputTokens) + (searched ? FAKE_SEARCH_USD : 0),
        ...(searched ? { webSearches: 1 } : {}),
      };
      yield { type: 'done', stopReason: 'end_turn' };
    } catch (err) {
      yield {
        type: 'error',
        error: {
          code: 'unknown',
          message: err instanceof Error ? err.message : 'Generation failed',
          retryable: false,
        },
      };
    }
  }

  return {
    id: OPENROUTER_PROVIDER_ID,
    kind: 'fake',
    label: 'Tangent',
    models: () => DEMO_MODELS.map((m) => ({ ...m })),
    defaultModel: () => DEMO_NORMAL_MODEL,
    capabilities: () => ({ ...CAPABILITIES }),
    stream,
  };
}
