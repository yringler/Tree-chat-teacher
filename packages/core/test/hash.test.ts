import { describe, expect, it } from 'vitest';
import { sha256Base64, sha256Hex } from '../src/hash.js';

interface NodeHash {
  update(data: string, encoding: 'utf8'): NodeHash;
  digest(encoding: 'hex' | 'base64'): string;
}
interface NodeCrypto {
  createHash(algorithm: 'sha256'): NodeHash;
}

// Loaded dynamically with a local type so the package does not need @types/node.
const nodeCryptoSpecifier: string = 'node:crypto';
const nodeCrypto = (await import(nodeCryptoSpecifier)) as NodeCrypto;

function nodeHex(input: string): string {
  return nodeCrypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

async function webCryptoHex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('sha256Hex', () => {
  it('hashes the empty string (NIST)', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('hashes "abc" (NIST)', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes the 448-bit two-block message (NIST)', () => {
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('hashes the 896-bit message (NIST)', () => {
    expect(
      sha256Hex(
        'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      ),
    ).toBe('cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1');
  });

  it('hashes one million "a" (NIST)', () => {
    expect(sha256Hex('a'.repeat(1_000_000))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('encodes multi-byte UTF-8 like node:crypto and Web Crypto', async () => {
    const input = 'Grüße, 世界! 🌳 — ẞ ñ';
    expect(sha256Hex(input)).toBe(nodeHex(input));
    expect(sha256Hex(input)).toBe(await webCryptoHex(input));
  });

  it('matches node:crypto around the padding boundaries', () => {
    for (let n = 50; n <= 130; n++) {
      const input = 'x'.repeat(n);
      expect(sha256Hex(input)).toBe(nodeHex(input));
    }
  });
});

describe('sha256Base64', () => {
  it('returns standard base64 of the digest', () => {
    expect(sha256Base64('abc')).toBe('ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
    const input = "alert('hi') — ü";
    expect(sha256Base64(input)).toBe(
      nodeCrypto.createHash('sha256').update(input, 'utf8').digest('base64'),
    );
  });
});
