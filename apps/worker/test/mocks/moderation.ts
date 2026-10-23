// Stand-in for the moderation classifier (POST https://api.openai.com/v1/moderations)
// in tests. It runs in Node (the Vitest host): vitest.config.ts's
// `outboundService` delegates the endpoint here. Module state lives for the
// whole run, so tests find their requests by a unique marker.
//
// - POST /v1/moderations (Bearer `mod-test…` required, else 401): one result
//   per input, every category near zero, except an input containing
//   `[mod-violent]` (violence 0.95), `[mod-sexual]` (sexual 0.6),
//   `[mod-graphic]` (violence/graphic 0.6) or `[mod-csam]` (sexual/minors 0.5).
//   A batch with `[mod-down]` gets a 500, one with `[mod-garbled]` a 200
//   missing a category.
//
// Control endpoint (plain `fetch()` from a test):
// - GET /__mock/moderation?contains=<text> → the input arrays of the requests
//   with an input containing <text>, oldest first

export const MODERATION_ORIGIN = 'https://api.openai.com';
const PATH = '/v1/moderations';

const CATEGORIES = [
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
];

const requests: string[][] = [];

function scoresOf(input: string): Record<string, number> {
  const out = Object.fromEntries(CATEGORIES.map((c) => [c, 0.001]));
  if (input.includes('[mod-violent]')) out['violence'] = 0.95;
  if (input.includes('[mod-sexual]')) out['sexual'] = 0.6;
  if (input.includes('[mod-graphic]')) out['violence/graphic'] = 0.6;
  if (input.includes('[mod-csam]')) out['sexual/minors'] = 0.5;
  return out;
}

export async function mockModeration(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/__mock/moderation' && request.method === 'GET') {
    const q = url.searchParams.get('contains') ?? '';
    return Response.json(requests.filter((inputs) => inputs.some((i) => i.includes(q))));
  }
  if (url.pathname !== PATH || request.method !== 'POST') {
    return new Response('blocked in tests', { status: 599 });
  }
  if (!(request.headers.get('authorization') ?? '').startsWith('Bearer mod-test')) {
    return Response.json({ error: { message: 'Incorrect API key' } }, { status: 401 });
  }
  const body = (await request.json()) as { model?: unknown; input?: unknown };
  if (
    typeof body.model !== 'string' ||
    !Array.isArray(body.input) ||
    !body.input.every((i) => typeof i === 'string')
  ) {
    return Response.json({ error: { message: 'Invalid request' } }, { status: 400 });
  }
  const inputs = body.input as string[];
  requests.push(inputs);
  if (inputs.some((i) => i.includes('[mod-down]'))) {
    return Response.json({ error: { message: 'Server error' } }, { status: 500 });
  }
  return Response.json({
    id: `modr-${requests.length}`,
    model: body.model,
    results: inputs.map((input) => {
      const category_scores = scoresOf(input);
      if (input.includes('[mod-garbled]')) delete category_scores['sexual/minors'];
      return { flagged: false, categories: {}, category_scores };
    }),
  });
}
