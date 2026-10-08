import '@angular/compiler'; // JIT: the component metadata below.
import { describe, expect, it } from 'vitest';
import { KeysDialog } from './keys-dialog';

/** Template of a JIT-compiled component (the decorator's metadata). */
function templateOf(type: object): string {
  const annotations = (type as { __annotations__?: { template?: string }[] }).__annotations__;
  return (annotations?.[0]?.template ?? '').replace(/\s+/g, ' ');
}

describe('Canvas keys dialog', () => {
  it('says the server decrypts the key on every request, as the power app does', () => {
    const t = templateOf(KeysDialog);
    expect(t).toContain(
      'Every chat request sends it back to the server, which decrypts it in memory to call the provider, so you are trusting this server not to log it.',
    );
    expect(t).toContain('It is not saved on the server.');
  });
});
