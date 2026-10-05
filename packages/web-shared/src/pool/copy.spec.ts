import '@angular/compiler'; // JIT: the component metadata below.
import { FORBIDDEN_POOL_COPY, POOL_NOTICE_TEXT, type PoolBlockDetails } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { BillingPage } from '../billing/billing-page';
import { PoolBlockNotice } from './pool-block-notice';
import { PoolFirstUseDialog } from './pool-first-use-dialog';
import { PoolFundSection } from './pool-fund-section';
import { poolBlockText, poolFundingNote, sessionsLabel } from './pool-format';
import { PoolMeter } from './pool-meter';

function templateOf(type: object): string {
  const annotations = (type as { __annotations__?: { template?: string }[] }).__annotations__;
  return annotations?.[0]?.template ?? '';
}

const REASONS: PoolBlockDetails['reason'][] = [
  'empty',
  'unpriced',
  'cap_requests',
  'cap_spend',
  'cap_ip',
  'cap_global',
  'rate',
];

describe('pool copy rule', () => {
  it('never says donate, donation or tax-deductible (templates)', () => {
    for (const type of [PoolFundSection, PoolMeter, PoolBlockNotice, PoolFirstUseDialog, BillingPage])
      expect(templateOf(type)).not.toMatch(FORBIDDEN_POOL_COPY);
  });

  it('never says it in generated text either', () => {
    const texts = [
      poolFundingNote(800),
      sessionsLabel({ sessionsRemaining: 3 }),
      POOL_NOTICE_TEXT,
    ];
    for (const reason of REASONS) {
      const t = poolBlockText({
        kind: reason === 'empty' || reason === 'unpriced' ? 'empty' : 'cap',
        details: {
          reason,
          limit: 30,
          resetAt: '2026-10-06T00:00:00.000Z',
          supporter: false,
          supporterLimit: 150,
        },
      });
      texts.push(t.title, t.detail ?? '', t.supporters ?? '');
    }
    for (const text of texts) expect(text).not.toMatch(FORBIDDEN_POOL_COPY);
  });
});
