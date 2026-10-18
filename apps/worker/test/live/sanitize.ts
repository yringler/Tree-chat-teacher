// Turns a response the live suite recorded into a fixture safe to commit
// (packages/providers/test/fixtures/live): ids become stable placeholders, signatures
// and encrypted blobs are redacted, thinking text and fetched page text are emptied,
// and nothing that looks like a key may remain. Runs on the Node host
// (vitest.live.config.ts); pure, with its own offline test (sanitize.test.ts).
import type { ContractExpectation } from '@tangent/providers/contract';

/** A recorded response as the host captured it: the status and body, never a header. */
export interface RecordedResponse {
  adapter: string;
  scenario: string;
  model: string;
  status: number;
  contentType: string;
  body: string;
  expectation: ContractExpectation;
}

/** Fixtures are small by design: a scenario asks for a few tokens. */
export const FIXTURE_MAX_BYTES = 64 * 1024;

/** Fields whose value is an opaque blob the upstream signed or encrypted. */
const REDACTED_KEYS: ReadonlySet<string> = new Set([
  'signature',
  'encrypted_content',
  'encrypted_index',
  'data',
]);
/** Thinking text, which a fixture never needs (the adapters drop it). */
const EMPTIED_TEXT_KEYS: ReadonlySet<string> = new Set(['reasoning', 'thinking', 'summary']);
/** Text of fetched pages, which belongs to their publishers. */
const PAGE_TEXT_KEYS: ReadonlySet<string> = new Set(['content', 'cited_text', 'snippet']);
const ID_KEYS: ReadonlySet<string> = new Set(['id', 'tool_use_id', 'user_id', 'request_id']);

/** What may never appear in a fixture, whatever field it hides in. */
const SECRET_PATTERNS: readonly RegExp[] = [/sk-[A-Za-z0-9]/, /bearer\s/i, /authorization/i];

class Placeholders {
  private readonly ids = new Map<string, string>();
  private readonly counts = new Map<string, number>();

  /** The same placeholder for the same id, keeping its prefix (`gen-`, `msg_`, `toolu_`). */
  of(id: string): string {
    const known = this.ids.get(id);
    if (known !== undefined) return known;
    const prefix = /^([A-Za-z]+[-_])/.exec(id)?.[1] ?? 'id-';
    const n = (this.counts.get(prefix) ?? 0) + 1;
    this.counts.set(prefix, n);
    const placeholder = `${prefix}${String(n).padStart(4, '0')}`;
    this.ids.set(id, placeholder);
    return placeholder;
  }
}

function clean(
  value: unknown,
  key: string | null,
  ids: Placeholders,
  inCitation: boolean,
): unknown {
  if (Array.isArray(value)) return value.map((v) => clean(v, key, ids, inCitation));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    const citation =
      inCitation ||
      key === 'url_citation' ||
      key === 'annotations' ||
      key === 'citations' ||
      ('type' in value && typeof value.type === 'string' && value.type.includes('search_result'));
    for (const [k, v] of Object.entries(value)) out[k] = clean(v, k, ids, citation);
    if (key === 'reasoning_details' || ('type' in out && String(out['type']).includes('thinking')))
      for (const k of ['text', 'summary', 'thinking']) if (typeof out[k] === 'string') out[k] = '';
    return out;
  }
  if (typeof value !== 'string' || key === null) {
    if (key === 'created' && typeof value === 'number') return 0;
    return value;
  }
  if (REDACTED_KEYS.has(key)) return '[redacted]';
  if (ID_KEYS.has(key)) return ids.of(value);
  if (EMPTIED_TEXT_KEYS.has(key)) return '';
  if (inCitation && PAGE_TEXT_KEYS.has(key)) return '';
  return value;
}

/** Each SSE `data:` line's JSON cleaned in place; other lines (events, comments, `[DONE]`) kept. */
function cleanSse(body: string, ids: Placeholders): string {
  return body
    .split('\n')
    .map((line) => {
      if (!line.startsWith('data:')) return line;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return line;
      try {
        return `data: ${JSON.stringify(clean(JSON.parse(payload), null, ids, false))}`;
      } catch {
        return line;
      }
    })
    .join('\n');
}

function cleanBody(body: string, contentType: string, ids: Placeholders): string {
  if (contentType.includes('text/event-stream')) return cleanSse(body, ids);
  try {
    return JSON.stringify(clean(JSON.parse(body), null, ids, false));
  } catch {
    return body;
  }
}

/**
 * The fixture of `recorded`, as the JSON text to write. Throws, and nothing is
 * written, when a `secrets` value or anything key-like survives, or when the
 * fixture would exceed FIXTURE_MAX_BYTES.
 */
export function sanitizeRecording(recorded: RecordedResponse, secrets: readonly string[]): string {
  const ids = new Placeholders();
  const fixture: RecordedResponse = {
    ...recorded,
    body: cleanBody(recorded.body, recorded.contentType, ids),
  };
  const text = `${JSON.stringify(fixture, null, 2)}\n`;
  for (const secret of secrets)
    if (secret.length >= 8 && text.includes(secret))
      throw new Error(`refusing to write ${recorded.scenario}: it contains a key`);
  for (const pattern of SECRET_PATTERNS)
    if (pattern.test(text))
      throw new Error(`refusing to write ${recorded.scenario}: it matches ${pattern}`);
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > FIXTURE_MAX_BYTES)
    throw new Error(`refusing to write ${recorded.scenario}: ${bytes} bytes is over the cap`);
  return text;
}
