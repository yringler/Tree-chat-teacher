/**
 * AES-256-GCM sealing for values that live in a browser cookie but must only
 * be readable by this Worker (bring-your-own-key, see keys.ts).
 *
 * Sealed format: `v1.` + base64url(iv[12] || ciphertext || tag[16]).
 * The version prefix lets the scheme change later without guessing; the
 * additional authenticated data binds a ciphertext to this purpose, so a
 * value sealed for something else with the same secret never opens here.
 */

const VERSION = 'v1';
const PREFIX = `${VERSION}.`;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const AAD = new TextEncoder().encode('tangent/llmkey/v1');

/** The server secret is missing or malformed. The message never includes the secret. */
export class SealConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealConfigError';
  }
}

/**
 * Any failure to open a sealed value: bad format, wrong version, tampered
 * ciphertext (GCM tag mismatch) or a rotated secret. Deliberately carries no
 * detail; callers treat it as "no key".
 */
export class UnsealError extends Error {
  constructor() {
    super('Sealed value could not be opened');
    this.name = 'UnsealError';
  }
}

// One imported key per isolate. Keyed by the secret so a rotated secret (new
// deployment, or a test swapping env) never reuses the old key.
let cached: { secret: string; key: Promise<CryptoKey> } | null = null;

function importKey(secret: string): Promise<CryptoKey> {
  if (cached?.secret === secret) return cached.key;
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = fromBase64(secret.trim());
  } catch {
    throw new SealConfigError(
      'KEY_ENCRYPTION_SECRET must be base64 (generate with `openssl rand -base64 32`)',
    );
  }
  if (raw.byteLength !== 32) {
    throw new SealConfigError(
      'KEY_ENCRYPTION_SECRET must decode to exactly 32 bytes (`openssl rand -base64 32`)',
    );
  }
  // extractable: false — the raw key can't be read back out of the CryptoKey.
  const key = crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
  cached = { secret, key };
  key.catch(() => {
    if (cached?.key === key) cached = null;
  });
  return key;
}

/** Encrypts `plaintext` with a fresh random IV. */
export async function seal(plaintext: string, secret: string): Promise<string> {
  const key = await importKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: AAD },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  const out = new Uint8Array(IV_BYTES + ct.byteLength);
  out.set(iv, 0);
  out.set(ct, IV_BYTES);
  return PREFIX + toBase64Url(out);
}

/**
 * Decrypts a value produced by `seal`. Throws UnsealError for anything that
 * doesn't authenticate; SealConfigError only for a broken server secret.
 */
export async function open(sealed: string, secret: string): Promise<string> {
  const key = await importKey(secret);
  if (!sealed.startsWith(PREFIX)) throw new UnsealError();
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64Url(sealed.slice(PREFIX.length));
  } catch {
    throw new UnsealError();
  }
  if (bytes.byteLength < IV_BYTES + TAG_BYTES + 1) throw new UnsealError();
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(0, IV_BYTES), additionalData: AAD },
      key,
      bytes.subarray(IV_BYTES),
    );
    return new TextDecoder('utf-8', { fatal: true }).decode(pt);
  } catch {
    throw new UnsealError();
  }
}

/** Short, stable, non-reversible id for a sealed value (rate-limit bucket). */
export async function fingerprint(sealed: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sealed)),
  );
  return [...digest.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('not base64url');
  return fromBase64(text.replace(/-/g, '+').replace(/_/g, '/'));
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
