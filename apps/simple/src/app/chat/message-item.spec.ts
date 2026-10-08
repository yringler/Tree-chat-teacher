import '@angular/compiler'; // JIT: compiles the component below without the Angular CLI.
import { CONTINUE_MESSAGE, isCutOffReply, REPLY_CUT_OFF_ERROR } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { MessageItem } from './message-item';

/** Template of a JIT-compiled component (the decorator's metadata). */
function templateOf(type: object): string {
  const annotations = (type as { __annotations__?: { template?: string }[] }).__annotations__;
  return annotations?.[0]?.template ?? '';
}

describe('MessageItem: a reply cut off at its length limit', () => {
  it('says "Cut off." with Continue instead of "The reply failed."', () => {
    const t = templateOf(MessageItem);
    const cutOff = t.indexOf('@if (cutOff())');
    const failed = t.indexOf("} @else if (n.status === 'error')");
    expect(cutOff).toBeGreaterThan(-1);
    expect(failed).toBeGreaterThan(cutOff);
    expect(t.slice(cutOff, failed)).toContain('<strong>Cut off.</strong>');
    expect(t.slice(cutOff, failed)).toContain('(click)="continueReply()"');
    expect(t.slice(cutOff, failed)).not.toContain('The reply failed.');
  });

  it('is told apart by its fixed message; Continue asks for the rest', () => {
    expect(isCutOffReply({ status: 'error', error: REPLY_CUT_OFF_ERROR })).toBe(true);
    expect(isCutOffReply({ status: 'error', error: 'Upstream died' })).toBe(false);
    expect(isCutOffReply({ status: 'complete', error: null })).toBe(false);
    expect(CONTINUE_MESSAGE).toMatch(/continue/i);
  });
});
