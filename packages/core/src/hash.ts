/**
 * Synchronous SHA-256 (pure TS, no Web Crypto) so the context assembler can
 * stay synchronous and I/O-free. Input strings are UTF-8 encoded.
 */
export function sha256Hex(input: string): string {
  void input;
  throw new Error('not implemented');
}

/** Standard base64 (not url-safe) of the raw digest — used for CSP hashes. */
export function sha256Base64(input: string): string {
  void input;
  throw new Error('not implemented');
}
