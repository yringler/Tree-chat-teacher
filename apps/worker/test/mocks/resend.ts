// Stand-in for https://api.resend.com in tests, so mail the Worker sends on
// its own (alerts) can be read back. It runs in Node (the Vitest host):
// vitest.config.ts's `outboundService` delegates this origin here. Module
// state lives for the whole run, so tests read mail by recipient.
//
// - POST /emails (Bearer key required): the key `re_down` gets a 500;
//   any other key is accepted and the message kept.
//
// Control endpoint (plain `fetch()` from a test):
// - GET /__mock/emails?to=<address> → the messages sent to it, oldest first

export const RESEND_ORIGIN = 'https://api.resend.com';

interface SentEmail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
}

const sent: SentEmail[] = [];

export async function mockResend(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/__mock/emails' && request.method === 'GET') {
    const to = url.searchParams.get('to') ?? '';
    return Response.json(sent.filter((m) => m.to.includes(to)));
  }
  if (url.pathname !== '/emails' || request.method !== 'POST') {
    return new Response('not found', { status: 404 });
  }
  const auth = request.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer re_')) {
    return Response.json({ name: 'missing_api_key', message: 'Missing API key' }, { status: 401 });
  }
  if (auth === 'Bearer re_down') {
    return Response.json({ name: 'internal_server_error', message: 'Down' }, { status: 500 });
  }
  sent.push((await request.json()) as SentEmail);
  return Response.json({ id: `email_${sent.length}` });
}
