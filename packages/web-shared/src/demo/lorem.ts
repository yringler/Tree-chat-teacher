import type {
  GenerateRequest,
  LlmProvider,
  ModelInfo,
  ProviderCapabilities,
  ProviderEvent,
} from '@tangent/shared';
import { getAdjectives, getNouns, sentence as txtSentence, setRandom, setTemplates } from 'txtgen';

/*
 * "Fun lorem ipsum" for the demo: English-ish nonsense from txtgen, shaped
 * like a Socratic tutor's reply (short paragraphs, sometimes a list or a
 * bold phrase, always ending with a question). Nothing here calls a model.
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

/** The demo provider's id and models, mirroring the real `tangent` provider. */
export const DEMO_PROVIDER_ID = 'tangent';
export const DEMO_SMART_MODEL = 'smart';
export const DEMO_SIMPLE_MODEL = 'simple';
export const DEMO_MODELS: readonly ModelInfo[] = [
  { id: DEMO_SMART_MODEL, label: 'Smart' },
  { id: DEMO_SIMPLE_MODEL, label: 'Simple' },
];

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

const QUESTIONS: readonly ((w: Words) => string)[] = [
  (w) =>
    `What do you think would happen if ${article(w.noun)} met ${article(w.adjective)} ${w.noun2}?`,
  () => 'Why might that be?',
  (w) => `Can you give an example of ${article(w.adjective)} ${w.noun}?`,
  (w) => `How would you explain ${plural(w.noun)} to ${article(w.noun2)}?`,
  (w) => `What makes ${article(w.noun)} different from ${article(w.noun2)}?`,
  (w) => `If every ${w.noun} were ${w.adjective}, what would change first?`,
  (w) => `Where have you seen ${article(w.adjective)} ${w.noun} before?`,
  () => 'What would you try next, and why?',
];

const OPENERS: readonly ((w: Words) => string)[] = [
  () => 'Good question!',
  (w) => `Let's start with **${article(w.adjective)} ${w.noun}**.`,
  () => "Here's one way to look at it.",
  (w) => `Think of it like **${article(w.noun)}**.`,
  () => 'Interesting! Let me put it simply.',
];

/** A closing question built from a template and txtgen words. */
export function loremQuestion(random: Random = Math.random): string {
  return pick(random, QUESTIONS)(words(random));
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
 * A tutor-shaped reply in Markdown: 1–3 short paragraphs (the Smart model
 * writes more), sometimes a bulleted list or a bold phrase, always ending
 * with a question.
 */
export function loremReply(model: string, random: Random = Math.random): string {
  return withRandom(random, () => {
    const smart = model !== DEMO_SIMPLE_MODEL;
    const paragraphs: string[] = [];
    const count = smart ? between(random, 2, 3) : between(random, 1, 2);
    for (let i = 0; i < count; i++) {
      let p = sentences(random, smart ? between(random, 2, 4) : between(random, 1, 3));
      if (i === 0 && random() < 0.5) p = `${pick(random, OPENERS)(words(random))} ${p}`;
      else if (random() < 0.35) p = boldSome(random, p);
      paragraphs.push(p);
    }
    if (random() < (smart ? 0.5 : 0.3)) {
      const items: string[] = [];
      for (let i = between(random, 2, smart ? 4 : 3); i > 0; i--) {
        const w = words(random);
        items.push(`- **${capitalize(plural(w.noun))}**: ${sentence()}`);
      }
      paragraphs.splice(Math.min(1, paragraphs.length), 0, items.join('\n'));
    }
    paragraphs.push(loremQuestion(random));
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
      let title = words.slice(0, TITLE_WORDS).join(' ');
      if (title.length > TITLE_CHARS) title = `${title.slice(0, TITLE_CHARS - 1).trimEnd()}…`;
      else if (words.length > TITLE_WORDS) title += '…';
      return title;
    }
  }
  return loremTitle(random);
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
};

/** Rough token count (4 characters per token), like the fake provider. */
function tokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Pretend price per token in USD: a few thousandths of a dollar per reply. */
function fakeCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const smart = model !== DEMO_SIMPLE_MODEL;
  const [inPrice, outPrice, base] = smart ? [5e-7, 2.5e-5, 0.002] : [2e-7, 1e-5, 0.001];
  return base + inputTokens * inPrice + outputTokens * outPrice;
}

/**
 * An LlmProvider that "generates" lorem replies word by word. Requests for
 * titles and summaries (by `usageTag.purpose`) get a title or a paragraph.
 * Follows the provider contract: never throws, ends with exactly one
 * `done` or `error` (`aborted` when the signal fires), reports `usage` and a
 * `billing` cost so the demo's balance moves.
 *
 * Its kind is `openai-compatible` (as the real `tangent` provider) rather
 * than `fake`: the ChatService skips auto-titles for fake providers.
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
      const streamed = !request.usageTag || request.usageTag.purpose === 'reply';
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
      yield { type: 'billing', costUsd: fakeCostUsd(request.model, inputTokens, outputTokens) };
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
    id: DEMO_PROVIDER_ID,
    kind: 'openai-compatible',
    label: 'Tangent',
    models: () => DEMO_MODELS.map((m) => ({ ...m })),
    defaultModel: () => DEMO_SMART_MODEL,
    capabilities: () => ({ ...CAPABILITIES }),
    stream,
  };
}
