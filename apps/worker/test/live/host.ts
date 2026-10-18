// The live suite's Node side, run by miniflare as the Worker's `outboundService`
// (vitest.live.config.ts): every fetch the Worker, its Durable Objects and the test
// files make arrives here. Provider hosts pass through to the real internet; Turnstile
// is answered locally (sign-in needs a pass, and it is no provider); everything else
// is refused. `https://live.test` is the suite's control origin: the spend budget, the
// report rows and record mode. Nothing here logs a request: its headers carry the keys.
import type { ContractExpectation } from '@tangent/providers/contract';
import { LIVE_CONTROL } from './bindings.js';
import { renderReport, type ReportFooter, type ReportRow } from './report.js';
import { sanitizeRecording } from './sanitize.js';

/** The hosts a live run may reach: the providers' APIs, nothing else. */
const PASSTHROUGH_HOSTS: ReadonlySet<string> = new Set([
  'openrouter.ai',
  'api.anthropic.com',
  'api.openai.com',
]);
/** The calls record mode captures: a chat completion or a message, never a lookup. */
const RECORDED_PATHS: readonly RegExp[] = [/\/chat\/completions$/, /\/v1\/messages$/];
/** Response headers that describe the encoding Node's fetch has already undone. */
const DROPPED_RESPONSE_HEADERS = ['content-encoding', 'content-length', 'transfer-encoding'];
/** Request headers Node's fetch sets itself. */
const DROPPED_REQUEST_HEADERS = ['host', 'content-length', 'connection', 'accept-encoding'];

export interface LiveHostOptions {
  budgetUsd: number;
  allowUnlimitedKey: boolean;
  record: boolean;
  /** Every key the run holds: a fixture containing one is never written. */
  secrets: readonly string[];
  /** Writes the report (apps/worker/.live/report.md). */
  writeReport(markdown: string): void;
  /** Writes a fixture at `relativePath` under packages/providers/test/fixtures/live. */
  writeFixture(relativePath: string, json: string): void;
}

/**
 * What OpenRouter's chat completions carried, by shape only (never a value but a
 * sanitized error chunk): the assumptions the adapter's fallbacks rest on.
 */
export interface StreamFacts {
  completions: number;
  /** Responses with an `x-generation-id` header (the id's fallback when no chunk has one). */
  withGenerationIdHeader: number;
  /** Streams with a `delta.tool_calls` (a search's activity event depends on one). */
  withToolCalls: number;
  /** Streams with `annotations` (citations). */
  withAnnotations: number;
  /** The first in-stream error chunk seen, sanitized. */
  errorChunk: string | null;
}

function noteStreamFacts(facts: StreamFacts, text: string, secrets: readonly string[]): void {
  if (text.includes('"tool_calls"')) facts.withToolCalls++;
  if (text.includes('"annotations"')) facts.withAnnotations++;
  if (facts.errorChunk !== null) return;
  const line = text.split('\n').find((l) => l.startsWith('data:') && l.includes('"error"'));
  if (!line) return;
  let chunk = line.slice(5).trim();
  for (const s of secrets) chunk = chunk.split(s).join('[key]');
  facts.errorChunk = chunk.slice(0, 600);
}

/**
 * `body` passed through as the Worker reads it, with its text handed to `onEnd` when it
 * ends or is cancelled. Never read ahead, so the host keeps no generation going that the
 * Worker stopped reading. (miniflare passes no cancel on to the outbound service, so an
 * aborted call's upstream generation still runs to its end here.)
 */
function watched(
  body: ReadableStream<Uint8Array>,
  onEnd: (text: string) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    onEnd(text + decoder.decode());
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          end();
          controller.close();
          return;
        }
        text += decoder.decode(value, { stream: true });
        controller.enqueue(value);
      } catch (e) {
        end();
        controller.error(e);
      }
    },
    async cancel(reason) {
      end();
      await reader.cancel(reason);
    },
  });
}

/**
 * The shape of a chat request the Worker sent: what the pool's scenarios check was
 * really asked upstream. Never the prompt, never a header.
 */
export interface RequestShape {
  host: string;
  model: string | null;
  maxTokens: number | null;
  tools: string[];
  reasoning: unknown;
  provider: unknown;
}

function shapeOf(host: string, body: ArrayBuffer): RequestShape | null {
  try {
    const json: unknown = JSON.parse(new TextDecoder().decode(body));
    if (typeof json !== 'object' || json === null) return null;
    const r = json as Record<string, unknown>;
    const max = r['max_tokens'] ?? r['max_completion_tokens'];
    return {
      host,
      model: typeof r['model'] === 'string' ? r['model'] : null,
      maxTokens: typeof max === 'number' ? max : null,
      tools: Array.isArray(r['tools'])
        ? r['tools'].map((t: unknown) =>
            typeof t === 'object' && t !== null && 'type' in t ? String(t.type) : '?',
          )
        : [],
      reasoning: r['reasoning'] ?? r['reasoning_effort'] ?? r['output_config'] ?? null,
      provider: r['provider'] ?? null,
    };
  } catch {
    return null;
  }
}

interface Recording {
  adapter: string;
  scenario: string;
  model: string;
  expectation: ContractExpectation;
  captured: Promise<{ status: number; contentType: string; body: string }> | null;
}

export function createLiveHost(options: LiveHostOptions): (request: Request) => Promise<Response> {
  const rows: ReportRow[] = [];
  const footer: ReportFooter = { budgetUsd: options.budgetUsd };
  const holds = new Map<number, number>();
  let nextHold = 1;
  /** Spent: settled tickets at their actual cost, open ones at their worst case. */
  let committedUsd = 0;
  let armed = false;
  let recording: Recording | null = null;
  /** Chat requests since the last `GET /__requests`. */
  let requests: RequestShape[] = [];
  const facts: StreamFacts = {
    completions: 0,
    withGenerationIdHeader: 0,
    withToolCalls: 0,
    withAnnotations: 0,
    errorChunk: null,
  };

  const writeReport = () =>
    options.writeReport(renderReport(rows, { ...footer, spentUsd: committedUsd, facts }));
  writeReport();

  async function control(request: Request, url: URL): Promise<Response> {
    const body: unknown = request.method === 'POST' ? await request.json() : null;
    const field = (name: string): unknown =>
      typeof body === 'object' && body !== null && name in body
        ? (body as Record<string, unknown>)[name]
        : undefined;
    switch (url.pathname) {
      case '/__settings':
        return Response.json({
          budgetUsd: options.budgetUsd,
          spentUsd: committedUsd,
          keyUsageStartUsd: footer.keyUsageStartUsd,
          allowUnlimitedKey: options.allowUnlimitedKey,
          record: options.record,
        });
      case '/__requests': {
        const sent = requests;
        requests = [];
        return Response.json(sent);
      }
      case '/__arm':
        armed = true;
        return Response.json({ armed });
      case '/__budget/reserve': {
        const usd = Number(field('usd'));
        if (!armed)
          return Response.json({ error: 'the preflight has not passed' }, { status: 409 });
        if (!(usd >= 0) || committedUsd + usd > options.budgetUsd)
          return Response.json(
            {
              error: `$${usd.toFixed(4)} more would pass the budget ($${committedUsd.toFixed(4)} of $${options.budgetUsd.toFixed(2)} committed)`,
            },
            { status: 409 },
          );
        const id = nextHold++;
        holds.set(id, usd);
        committedUsd += usd;
        return Response.json({ id });
      }
      case '/__budget/settle': {
        const id = Number(field('id'));
        const worst = holds.get(id);
        const actual = Number(field('usd'));
        if (worst !== undefined && Number.isFinite(actual) && actual >= 0) {
          committedUsd += actual - worst;
          holds.delete(id);
        }
        writeReport();
        return Response.json({ committedUsd });
      }
      case '/__observe':
        rows.push(body as ReportRow);
        writeReport();
        return Response.json({ rows: rows.length });
      case '/__footer': {
        const probes = { ...footer.probes, ...(field('probes') as Record<string, string>) };
        Object.assign(footer, body, { probes });
        writeReport();
        return Response.json(footer);
      }
      case '/__record/start':
        if (!options.record) return Response.json({ recording: false });
        recording = {
          adapter: String(field('adapter')),
          scenario: String(field('scenario')),
          model: String(field('model')),
          expectation: field('expectation') as ContractExpectation,
          captured: null,
        };
        return Response.json({ recording: true });
      case '/__record/stop': {
        const done = recording;
        recording = null;
        if (!done?.captured || field('keep') !== true) return Response.json({ written: null });
        const captured = await done.captured;
        let text: string;
        try {
          text = sanitizeRecording(
            {
              adapter: done.adapter,
              scenario: done.scenario,
              model: done.model,
              expectation: done.expectation,
              ...captured,
            },
            options.secrets,
          );
        } catch (e) {
          return Response.json({
            written: null,
            refused: e instanceof Error ? e.message : String(e),
          });
        }
        const file = `${done.adapter}/${done.scenario}.json`;
        options.writeFixture(file, text);
        return Response.json({ written: file });
      }
      default:
        return new Response('unknown control path', { status: 404 });
    }
  }

  async function passthrough(request: Request, url: URL): Promise<Response> {
    const headers = new Headers(request.headers);
    for (const name of DROPPED_REQUEST_HEADERS) headers.delete(name);
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const sent = hasBody ? await request.arrayBuffer() : null;
    if (sent && RECORDED_PATHS.some((p) => p.test(url.pathname))) {
      const shape = shapeOf(url.hostname, sent);
      if (shape) requests.push(shape);
    }
    const res = await fetch(url, {
      method: request.method,
      headers,
      body: sent,
      redirect: 'manual',
      signal: request.signal,
    });
    const responseHeaders = new Headers(res.headers);
    for (const name of DROPPED_RESPONSE_HEADERS) responseHeaders.delete(name);
    if (!res.body) return new Response(null, { status: res.status, headers: responseHeaders });
    const isChat = RECORDED_PATHS.some((p) => p.test(url.pathname));
    const capture = recording && !recording.captured && isChat ? recording : null;
    const factual = res.ok && url.hostname === 'openrouter.ai' && isChat;
    if (factual) {
      facts.completions++;
      if (res.headers.get('x-generation-id')) facts.withGenerationIdHeader++;
    }
    let resolveCaptured: (text: string) => void = () => undefined;
    if (capture) {
      const contentType = res.headers.get('content-type') ?? '';
      capture.captured = new Promise<string>((r) => (resolveCaptured = r)).then((text) => ({
        status: res.status,
        contentType,
        body: text,
      }));
    }
    const body =
      factual || capture
        ? watched(res.body, (text) => {
            if (factual) noteStreamFacts(facts, text, options.secrets);
            resolveCaptured(text);
          })
        : res.body;
    return new Response(body, { status: res.status, headers: responseHeaders });
  }

  /** Cloudflare's siteverify for sign-in: the token `pass` passes, like the unit suites' stand-in. */
  async function turnstile(request: Request): Promise<Response> {
    const { response } = (await request.json()) as { response?: string };
    const ok = response === 'pass';
    return Response.json({
      success: ok,
      hostname: 'tangent.example.com',
      'error-codes': ok ? [] : ['invalid-input-response'],
    });
  }

  return async (request) => {
    const url = new URL(request.url);
    if (url.origin === LIVE_CONTROL) return control(request, url);
    if (url.origin === 'https://challenges.cloudflare.com') return turnstile(request);
    if (url.protocol === 'https:' && PASSTHROUGH_HOSTS.has(url.hostname))
      return passthrough(request, url);
    return new Response(`blocked in live tests: ${url.hostname}`, { status: 599 });
  };
}
