import { describe, expect, it } from 'vitest';
import { CANDIDATE_EVENT_TYPES, CANDIDATE_TTL_MS, candidateRequestSchema } from './compare.js';

describe('candidateRequestSchema', () => {
  it('accepts a question and a model; the route defaults to the branch', () => {
    expect(candidateRequestSchema.parse({ content: 'Why?', model: 'vendor/m' })).toEqual({
      content: 'Why?',
      model: 'vendor/m',
    });
    expect(
      candidateRequestSchema.parse({
        content: 'Why?',
        model: 'vendor/m',
        providerId: 'anthropic',
        funding: 'own-key',
      }),
    ).toEqual({ content: 'Why?', model: 'vendor/m', providerId: 'anthropic', funding: 'own-key' });
  });

  it('rejects an empty question, a missing model and an unknown funding', () => {
    expect(candidateRequestSchema.safeParse({ content: '', model: 'm' }).success).toBe(false);
    expect(candidateRequestSchema.safeParse({ content: 'q' }).success).toBe(false);
    expect(
      candidateRequestSchema.safeParse({ content: 'q', model: 'm', funding: 'pool' }).success,
    ).toBe(false);
  });

  it('reads the legacy `tangent` id as the built-in endpoint on credit', () => {
    expect(
      candidateRequestSchema.parse({ content: 'q', model: 'm', providerId: 'tangent' }),
    ).toEqual({ content: 'q', model: 'm', providerId: 'openrouter', funding: 'credit' });
  });

  it('lists the event types and holds a candidate for half an hour', () => {
    expect([...CANDIDATE_EVENT_TYPES].sort()).toEqual(['delta', 'done', 'error', 'status']);
    expect(CANDIDATE_TTL_MS).toBe(1_800_000);
  });
});
