// Stand-in for https://openrouter.ai in tests (GET /api/v1/generation).
// It runs in Node (the Vitest host), not in workerd: vitest.config.ts's
// `outboundService` delegates every outbound request to this origin here.
// Keep it free of `cloudflare:*` imports. Module state lives for the whole
// run and is shared by every test file, so scripts are keyed by generation id.
//
// - GET /api/v1/generation?id=<id> (Bearer key required, else 401): plays the
//   responses scripted for <id> in order, repeating the last one; an id with
//   no script → 404 (OpenRouter's "not yet available").
//
// Control endpoints (plain `fetch()` from a test):
// - POST /__mock/generation { id, responses: [{ status, body? } | { costUsd, inputTokens?, outputTokens?, cancelled? }] }
//   scripts <id>; a `costUsd` entry is shorthand for a 200 with that data
//   (`numSearchResults` → `num_search_results`).
// - GET  /__mock/generation-calls?id=<id> → { count, authorizations }

export const OPENROUTER_ORIGIN = 'https://openrouter.ai';

export type ScriptedGeneration =
  | { status: number; body?: unknown }
  | {
      costUsd: number;
      inputTokens?: number;
      outputTokens?: number;
      cancelled?: boolean;
      numSearchResults?: number;
    };

interface Script {
  responses: ScriptedGeneration[];
  calls: number;
  authorizations: string[];
}

const scripts = new Map<string, Script>();

function scriptFor(id: string): Script {
  let s = scripts.get(id);
  if (!s) {
    s = { responses: [], calls: 0, authorizations: [] };
    scripts.set(id, s);
  }
  return s;
}

function render(id: string, entry: ScriptedGeneration | undefined): Response {
  if (!entry)
    return Response.json(
      { error: { code: 404, message: 'Generation not found' } },
      { status: 404 },
    );
  if ('status' in entry) {
    return entry.body === undefined
      ? new Response(null, { status: entry.status })
      : Response.json(entry.body, { status: entry.status });
  }
  return Response.json({
    data: {
      id,
      total_cost: entry.costUsd,
      native_tokens_prompt: entry.inputTokens ?? 10,
      native_tokens_completion: entry.outputTokens ?? 20,
      native_tokens_reasoning: 0,
      cancelled: entry.cancelled ?? false,
      finish_reason: entry.cancelled ? null : 'stop',
      model: 'deepseek/deepseek-v4-flash',
      is_byok: false,
      num_search_results: entry.numSearchResults ?? 0,
    },
  });
}

export async function mockOpenRouter(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/__mock/generation' && request.method === 'POST') {
    const body = (await request.json()) as { id: string; responses: ScriptedGeneration[] };
    const s = scriptFor(body.id);
    s.responses = [...body.responses];
    return Response.json({ ok: true });
  }
  if (url.pathname === '/__mock/generation-calls' && request.method === 'GET') {
    const s = scripts.get(url.searchParams.get('id') ?? '');
    return Response.json({ count: s?.calls ?? 0, authorizations: s?.authorizations ?? [] });
  }
  if (url.pathname === '/api/v1/generation' && request.method === 'GET') {
    const id = url.searchParams.get('id') ?? '';
    const auth = request.headers.get('authorization') ?? '';
    const s = scriptFor(id);
    s.calls += 1;
    s.authorizations.push(auth);
    if (!/^Bearer \S+/.test(auth)) {
      return Response.json(
        { error: { code: 401, message: 'No auth credentials found' } },
        { status: 401 },
      );
    }
    const entry = s.responses.length > 1 ? s.responses.shift() : s.responses[0];
    return render(id, entry);
  }
  return Response.json({ error: { code: 404, message: 'Not found' } }, { status: 404 });
}
