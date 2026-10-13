// Stand-in for https://www.googleapis.com in tests: Google's signing keys,
// which Better Auth fetches to check an ID token the phone app signs in with.
// It runs in Node (the Vitest host): vitest.config.ts's `outboundService`
// delegates this origin here. The key pair is made once per run.
//
// - GET /oauth2/v3/certs → the public key as a JWK set
//
// Control endpoint (plain `fetch()` from a test):
// - GET /__mock/id-token?email=<address>&aud=<client id>[&verified=false]
//   → an ID token for that address, signed with the key above, as Google
//   would issue it to the app

export const GOOGLE_APIS_ORIGIN = 'https://www.googleapis.com';

const KID = 'mock-google-key';
const ALGORITHM = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

let keys: Promise<CryptoKeyPair> | null = null;

function keyPair(): Promise<CryptoKeyPair> {
  keys ??= crypto.subtle.generateKey(
    { ...ALGORITHM, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ['sign', 'verify'],
  );
  return keys;
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

async function idToken(email: string, audience: string, verified: boolean): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const signed = `${encode({ alg: 'RS256', kid: KID, typ: 'JWT' })}.${encode({
    iss: 'https://accounts.google.com',
    aud: audience,
    sub: `google-${email}`,
    email,
    email_verified: verified,
    name: 'Test User',
    iat: now,
    exp: now + 3600,
  })}`;
  const { privateKey } = await keyPair();
  const signature = await crypto.subtle.sign(
    ALGORITHM,
    privateKey,
    new TextEncoder().encode(signed),
  );
  return `${signed}.${base64url(new Uint8Array(signature))}`;
}

export async function mockGoogleApis(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/oauth2/v3/certs') {
    const jwk = await crypto.subtle.exportKey('jwk', (await keyPair()).publicKey);
    return Response.json({ keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] });
  }
  if (url.pathname === '/__mock/id-token') {
    const email = url.searchParams.get('email') ?? '';
    const audience = url.searchParams.get('aud') ?? '';
    return new Response(
      await idToken(email, audience, url.searchParams.get('verified') !== 'false'),
    );
  }
  return new Response('not found', { status: 404 });
}
