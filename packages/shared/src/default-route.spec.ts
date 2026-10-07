import { describe, expect, it } from 'vitest';
import { pickDefaultRoute, type DefaultRouteCandidate } from './default-route.js';

type Entry = DefaultRouteCandidate & { label: string };

const entry = (
  id: string,
  over: Partial<Entry> = {},
  kind: DefaultRouteCandidate['kind'] = 'openai-compatible',
): Entry => ({ id, kind, available: false, funding: 'own-key', label: id, ...over });

/** Power's default own-key list (PROVIDERS unset), with keys for `keys`. */
function defaults(keys: string[] = []): Entry[] {
  return [
    entry('anthropic', { available: keys.includes('anthropic') }, 'anthropic'),
    entry('openai', { available: keys.includes('openai') }),
    entry('openrouter', { available: keys.includes('openrouter') }),
  ];
}
/** A self-hosted list without OpenRouter. */
function selfHosted(keys: string[] = []): Entry[] {
  return [
    entry('anthropic', { available: keys.includes('anthropic') }, 'anthropic'),
    entry('openai', { available: keys.includes('openai') }),
  ];
}
/** Tangent credit as `/api/providers` lists it where offered (the operator's key, so available). */
const credit = entry('openrouter', { funding: 'credit', available: true, label: 'Tangent credit' });

const pick = (entries: Entry[], creditCanPay = false, ownKeyLocked = false) => {
  const p = pickDefaultRoute(entries, { creditCanPay, ownKeyLocked });
  return p && `${p.id}@${p.funding ?? 'own-key'}`;
};

describe('pickDefaultRoute (the default route of a new tree)', () => {
  it('1. an own-key provider with a key comes first, in the configured order, credit or not', () => {
    expect(pick(defaults(['openrouter']))).toBe('openrouter@own-key');
    expect(pick(defaults(['openai', 'openrouter']))).toBe('openai@own-key');
    expect(pick([...defaults(['openai']), credit], true)).toBe('openai@own-key');
    expect(pick([...defaults(['openai']), credit], false)).toBe('openai@own-key');
    expect(pick([...selfHosted(['openai']), credit], true)).toBe('openai@own-key');
  });

  it('2. no key: Tangent credit when it is offered and the balance is above zero', () => {
    expect(pick([...defaults(), credit], true)).toBe('openrouter@credit');
    expect(pick([...selfHosted(), credit], true)).toBe('openrouter@credit');
  });

  it('3. no key and credit unable to pay (zero balance, or not offered): OpenRouter on the own key', () => {
    // Offered, zero balance: never onto credit.
    expect(pick([...defaults(), credit], false)).toBe('openrouter@own-key');
    // Not offered (no credit entry), whatever the balance.
    expect(pick(defaults(), false)).toBe('openrouter@own-key');
    expect(pick(defaults(), true)).toBe('openrouter@own-key');
    // Offered but unusable (no operator key): not a route that can pay.
    expect(pick([...defaults(), { ...credit, available: false }], true)).toBe('openrouter@own-key');
  });

  it('4. no OpenRouter configured: the first configured own-key provider', () => {
    expect(pick(selfHosted())).toBe('anthropic@own-key');
    expect(pick([...selfHosted(), credit], false)).toBe('anthropic@own-key');
  });

  it('own keys needing a membership the user lacks: credit wins whatever the balance', () => {
    // Even over a saved key: replies on it would be refused.
    expect(pick([...defaults(['openrouter']), credit], true, true)).toBe('openrouter@credit');
    expect(pick([...defaults(), credit], true, true)).toBe('openrouter@credit');
    // An empty balance too: anyone can buy credit, and a locked own key can't reply at all.
    expect(pick([...defaults(['openai']), credit], false, true)).toBe('openrouter@credit');
    expect(pick([...defaults(), credit], false, true)).toBe('openrouter@credit');
    expect(pick([...selfHosted(), credit], false, true)).toBe('openrouter@credit');
    // Credit not offered, or unusable: the usual own-key order.
    expect(pick(defaults(), true, true)).toBe('openrouter@own-key');
    expect(pick([...selfHosted(), { ...credit, available: false }], false, true)).toBe(
      'anthropic@own-key',
    );
  });

  it('test providers (`fake`): never over a usable real route, never on credit, and only as configured', () => {
    const fake = entry('fake', { available: true }, 'fake');
    const fakeCredit = { ...credit, kind: 'fake' as const };
    // Only fakes configured: the fake.
    expect(pick([fake])).toBe('fake@own-key');
    expect(pick([entry('fake', {}, 'fake')])).toBe('fake@own-key');
    // A usable real provider or credit that can pay comes first.
    expect(pick([fake, ...defaults(['openai'])])).toBe('openai@own-key');
    expect(pick([fake, ...defaults(), credit], true)).toBe('openrouter@credit');
    // Otherwise the operator's test provider, which needs no key, before keyless real ones.
    expect(pick([fake, ...defaults(), credit], false)).toBe('fake@own-key');
    // A fake built-in endpoint is never a default credit route.
    expect(pick([...defaults(), fakeCredit], true)).toBe('openrouter@own-key');
    expect(pick([...selfHosted(), fakeCredit], true, true)).toBe('anthropic@own-key');
    // An `openrouter` id that is a fake is no OpenRouter key to ask for.
    expect(pick([entry('openrouter', {}, 'fake'), ...selfHosted()])).toBe('anthropic@own-key');
  });

  it('entries without a funding are own-key (Learn); nothing to pick is null', () => {
    expect(
      pickDefaultRoute([{ id: 'openrouter', kind: 'openai-compatible', available: false }], {
        creditCanPay: true,
        ownKeyLocked: false,
      })?.id,
    ).toBe('openrouter');
    expect(pick([])).toBeNull();
    expect(pick([credit], false)).toBeNull();
    expect(pick([credit], true)).toBe('openrouter@credit');
  });

  it('returns the entry itself, so callers read its default model', () => {
    const list = [...defaults(), credit];
    expect(pickDefaultRoute(list, { creditCanPay: false, ownKeyLocked: false })).toBe(list[2]);
    expect(pickDefaultRoute(list, { creditCanPay: true, ownKeyLocked: false })).toBe(credit);
  });
});
