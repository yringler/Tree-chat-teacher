import '@angular/compiler'; // JIT: compiles the component below without the Angular CLI.
import {
  Injector,
  reflectComponentType,
  runInInjectionContext,
  type StaticProvider,
} from '@angular/core';
import type { CopyToLearnResponse, MembershipInfo, ProviderInfo } from '@tangent/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from '../core/api-client';
import { LEAVE_PAGE } from '../core/leave-page';
import {
  LearnCopy,
  learnCopyWay,
  learnLessonHref,
  lockedFundings,
  readOnlyText,
  routeLocked,
  routeOpen,
} from './read-only';
import { ReadOnlyComposer } from './read-only-composer';

function membership(over: Partial<MembershipInfo> = {}): MembershipInfo {
  return {
    required: true,
    status: 'inactive',
    subscriptionStatus: 'canceled',
    periodEnd: null,
    cancelAtPeriodEnd: false,
    priceCents: 1000,
    includedCreditCents: 0,
    ...over,
  };
}

function provider(over: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id: 'openrouter',
    kind: 'openai-compatible',
    label: 'OpenRouter',
    models: [],
    defaultModel: 'a/b',
    openModels: true,
    available: true,
    acceptsUserKey: true,
    keySource: 'user',
    funding: 'own-key',
    ...over,
  };
}

/** Template of a JIT-compiled component (the decorator's metadata). */
function templateOf(type: object): string {
  const annotations = (type as { __annotations__?: { template?: string }[] }).__annotations__;
  return annotations?.[0]?.template ?? '';
}

function create<T>(type: new () => T, providers: StaticProvider[]): T {
  return runInInjectionContext(Injector.create({ providers }), () => new type());
}

describe('lockedFundings and routeLocked', () => {
  it("locks what the server says needs the membership, only while the user hasn't one", () => {
    expect([...lockedFundings(['own-key'], membership())]).toEqual(['own-key']);
    expect([...lockedFundings(['own-key'], membership({ status: 'active' }))]).toEqual([]);
    expect([...lockedFundings(['own-key'], membership({ status: 'waived' }))]).toEqual([]);
    // No membership required (the fee off, a server without billing): never locked.
    expect([...lockedFundings(['own-key'], membership({ required: false }))]).toEqual([]);
    expect([...lockedFundings([], membership())]).toEqual([]);
    expect([...lockedFundings(undefined, null)]).toEqual([]);
  });

  it('reads a route without a funding as the own key', () => {
    const locked = lockedFundings(['own-key'], membership());
    expect(routeLocked(locked, {})).toBe(true);
    expect(routeLocked(locked, { funding: 'own-key' })).toBe(true);
    expect(routeLocked(locked, { funding: 'credit' })).toBe(false);
  });
});

describe('routeOpen', () => {
  const locked = lockedFundings(['own-key'], membership());
  const credit = provider({ funding: 'credit', acceptsUserKey: false, keySource: 'server' });

  it('needs a key, an unlocked funding and, for credit, credit to spend', () => {
    expect(routeOpen(provider(), new Set(), true)).toBe(true);
    expect(routeOpen(provider({ available: false }), new Set(), true)).toBe(false);
    expect(routeOpen(provider(), locked, true)).toBe(false);
    expect(routeOpen(credit, locked, true)).toBe(true);
    expect(routeOpen(credit, locked, false)).toBe(false);
  });
});

describe('readOnlyText', () => {
  it('asks a lapsed member to renew, and offers no copy in Learn where Learn could not reply', () => {
    expect(readOnlyText(membership())).toEqual({
      lead: 'Your membership has ended.',
      body: 'Renew your membership to continue this conversation.',
      act: 'Renew your membership',
      renew: 'Renew membership',
    });
  });

  it('offers the copy in Learn on the open pool while it is on', () => {
    expect(readOnlyText(membership(), false, 'pool').body).toBe(
      'Renew your membership to continue this conversation, or create a copy to continue it in Learn on the open pool.',
    );
  });

  it('asks someone who never had one to become a member, and mentions credit when it can carry on', () => {
    const t = readOnlyText(membership({ subscriptionStatus: null }), true, 'credit');
    expect(t.lead).toBe('Replies on your own API keys need a membership.');
    expect(t.renew).toBe('Become a member');
    expect(t.body).toBe(
      'Become a member to continue this conversation, or create a copy to continue it in Learn on Tangent credit. You can also continue it on Tangent credit, which needs no membership.',
    );
  });
});

describe('learnCopyWay', () => {
  it('is the pool while it is on, else credit where it carries on, else nothing', () => {
    expect(learnCopyWay(true, true)).toBe('pool');
    expect(learnCopyWay(true, false)).toBe('pool');
    expect(learnCopyWay(false, true)).toBe('credit');
    expect(learnCopyWay(false, false)).toBeNull();
  });
});

describe('LearnCopy', () => {
  it('copies on the server, then opens the lesson in Learn; stays pending while the page leaves', async () => {
    const api = {
      copyToLearn: vi.fn(async (_id: string): Promise<CopyToLearnResponse> => ({
        treeId: 'l/1',
        title: 'Primes',
      })),
    };
    const leave = vi.fn();
    const copy = new LearnCopy(api, leave);
    await copy.copy('t1');
    expect(api.copyToLearn).toHaveBeenCalledWith('t1');
    expect(leave).toHaveBeenCalledWith('/learn/t/l%2F1');
    expect(copy.pending()).toBe(true);
    // A second click while leaving does nothing.
    await copy.copy('t1');
    expect(api.copyToLearn).toHaveBeenCalledTimes(1);
    copy.reset();
    expect(copy.pending()).toBe(false);
  });

  it('says why a copy failed and lets the user try again', async () => {
    const api = {
      copyToLearn: vi.fn(async (): Promise<CopyToLearnResponse> => {
        throw new ApiError(404, 'not_found', 'Tree not found');
      }),
    };
    const leave = vi.fn();
    const copy = new LearnCopy(api, leave);
    await copy.copy('gone');
    expect(leave).not.toHaveBeenCalled();
    expect(copy.pending()).toBe(false);
    expect(copy.error()).toBe("Couldn't copy it to Learn: Tree not found");
  });

  it("links to Learn's lesson route", () => {
    expect(learnLessonHref('abc')).toBe('/learn/t/abc');
  });
});

describe('ReadOnlyComposer', () => {
  it('is <app-read-only-composer>', () => {
    expect(reflectComponentType(ReadOnlyComposer)?.selector).toBe('app-read-only-composer');
  });

  it('explains, links to the billing page to renew, copies to Learn when it can reply and offers credit when asked', () => {
    const t = templateOf(ReadOnlyComposer);
    expect(t).toContain('{{ text().lead }}');
    expect(t).toContain('{{ text().body }}');
    expect(t).toContain('[href]="billingHref()">{{ text().renew }}</a>');
    expect(t).toContain('@if (learn())');
    expect(t).toContain('(click)="copier.copy(treeId())"');
    expect(t).toContain("{{ copier.pending() ? 'Copying…' : 'Create a copy in Learn' }}");
    expect(t).toContain('@if (credit())');
    expect(t).toContain('(click)="useCredit.emit()"');
    expect(t).toContain('@if (copier.error(); as e)');
    // No message box: nothing here sends.
    expect(t).not.toContain('<textarea');
  });

  it('copies through the API and leaves for the lesson in Learn', async () => {
    const api = {
      copyToLearn: vi.fn(async (_id: string): Promise<CopyToLearnResponse> => ({
        treeId: 'l1',
        title: 'Primes',
      })),
    };
    const leave = vi.fn();
    const c = create(ReadOnlyComposer, [
      { provide: ApiClient, useValue: api },
      { provide: LEAVE_PAGE, useValue: leave },
    ]);
    const copier = (c as unknown as { copier: LearnCopy }).copier;
    await copier.copy('t1');
    expect(api.copyToLearn).toHaveBeenCalledWith('t1');
    expect(leave).toHaveBeenCalledWith('/learn/t/l1');
  });
});
