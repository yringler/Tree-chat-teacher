import { describe, expect, it } from 'vitest';
import {
  decideGrounding,
  groundingScore,
  type GroundingInput,
} from '../../src/grounding/policy.js';

const base: GroundingInput = {
  policy: 'auto',
  branchMode: 'auto',
  explicit: false,
  supported: true,
  autoAllowed: true,
  depth: 0,
  userText: 'What is a monad?',
  lossyContext: false,
};

describe('groundingScore', () => {
  it.each([
    ['conceptual trunk question', { userText: 'Why does ice float?' }, -1],
    ['plain trunk question', { userText: 'What is a monad?' }, 0],
    ['tangent', { depth: 1 }, 1],
    ['deep tangent', { depth: 3 }, 2],
    ['year', { userText: 'What happened in 1848?' }, 2],
    ['who invented', { userText: 'who invented the transistor' }, 2],
    ['number with unit', { userText: 'Is it really 40% efficient?' }, 2],
    ['recency', { userText: 'What is the latest version?' }, 2],
    ['sources', { userText: 'Is there a study on that?' }, 2],
    ['named entities', { userText: 'Did Gauss know Riemann well?' }, 1],
    ['summarized context', { lossyContext: true }, 1],
    ['conceptual with a fact is not discounted', { userText: 'Why did it fail in 1986?' }, 2],
  ] as const)('%s', (_name, patch, expected) => {
    expect(groundingScore({ ...base, ...patch }).score).toBe(expected);
  });
});

describe('decideGrounding', () => {
  it('offers search at or above the threshold, not below', () => {
    expect(decideGrounding({ ...base, depth: 2 }).mode).toBe('auto');
    expect(decideGrounding({ ...base, depth: 1 }).mode).toBe('none');
    expect(decideGrounding({ ...base, depth: 1, lossyContext: true }).mode).toBe('auto');
    expect(decideGrounding({ ...base, depth: 2, userText: 'Explain the intuition' }).mode).toBe(
      'none',
    );
  });

  it('requires search for an explicit check, even under the explicit policy or an off branch', () => {
    expect(decideGrounding({ ...base, explicit: true }).mode).toBe('required');
    expect(decideGrounding({ ...base, explicit: true, policy: 'explicit' }).mode).toBe('required');
    expect(decideGrounding({ ...base, explicit: true, branchMode: 'off' }).mode).toBe('required');
    expect(decideGrounding({ ...base, explicit: true, autoAllowed: false }).mode).toBe('required');
  });

  it('never searches when unsupported or the policy is off', () => {
    expect(decideGrounding({ ...base, explicit: true, supported: false }).mode).toBe('none');
    expect(decideGrounding({ ...base, explicit: true, policy: 'off' }).mode).toBe('none');
  });

  it('respects the explicit policy, an off branch and the daily cap for automatic searches', () => {
    const deep = { ...base, depth: 4 };
    expect(decideGrounding({ ...deep, policy: 'explicit' }).mode).toBe('none');
    expect(decideGrounding({ ...deep, branchMode: 'off' }).mode).toBe('none');
    expect(decideGrounding({ ...deep, autoAllowed: false }).mode).toBe('none');
  });

  it('always offers under always-offer or an always branch', () => {
    expect(decideGrounding({ ...base, policy: 'always-offer', userText: 'Why?' }).mode).toBe(
      'auto',
    );
    expect(decideGrounding({ ...base, branchMode: 'always', userText: 'Why?' }).mode).toBe('auto');
    expect(decideGrounding({ ...base, branchMode: 'always', autoAllowed: false }).mode).toBe(
      'none',
    );
  });
});
