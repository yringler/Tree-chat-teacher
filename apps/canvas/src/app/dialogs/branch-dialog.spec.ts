import '@angular/compiler'; // JIT: the component metadata and the DI below.
import { Injector, runInInjectionContext, signal } from '@angular/core';
import { Router } from '@angular/router';
import type {
  BillingSummary,
  Branch,
  ChatNode,
  MembershipInfo,
  MeResponse,
  PoolStatusResponse,
  ProviderInfo,
  TreeDetail,
} from '@tangent/shared';
import { ApiClient, ComposerController, ToastStore } from '@tangent/web-shared';
import { describe, expect, it, vi } from 'vitest';
import { CanvasStore } from '../state/canvas-store';
import { UiStore } from '../state/ui-store';
import { BranchDialog } from './branch-dialog';

const T = '2026-01-01T00:00:00.000Z';

const ownKey: ProviderInfo = {
  id: 'openrouter',
  kind: 'openai-compatible',
  label: 'OpenRouter',
  models: [{ id: 'vendor/listed', label: 'Listed' }],
  defaultModel: 'vendor/listed',
  openModels: true,
  available: true,
  acceptsUserKey: true,
  keySource: 'user',
  funding: 'own-key',
};
const credit: ProviderInfo = {
  ...ownKey,
  label: 'Tangent credit',
  defaultModel: 'vendor/default',
  acceptsUserKey: false,
  keySource: 'server',
  funding: 'credit',
};

function membership(status: MembershipInfo['status']): MembershipInfo {
  return {
    required: true,
    status,
    subscriptionStatus: null,
    periodEnd: null,
    cancelAtPeriodEnd: false,
    priceCents: 1000,
  };
}

/** A trunk on the user's own key, its one reply `a1`. */
function tree(): TreeDetail {
  const trunk: Branch = {
    id: 'trunk',
    treeId: 't1',
    parentBranchId: null,
    branchPointNodeId: null,
    contextMode: 'path',
    anchorQuote: null,
    title: 'Main thread',
    titleSource: 'default',
    isPrivate: false,
    providerId: 'openrouter',
    model: 'vendor/x',
    funding: 'own-key',
    createdAt: T,
    updatedAt: T,
  };
  const reply: ChatNode = {
    id: 'a1',
    treeId: 't1',
    branchId: 'trunk',
    parentId: null,
    seq: 0,
    role: 'assistant',
    content: 'A wave.',
    status: 'complete',
    error: null,
    providerId: 'openrouter',
    model: 'vendor/x',
    usage: null,
    createdAt: T,
  };
  return {
    tree: {
      id: 't1',
      accountId: 'u_1',
      title: 'Light',
      systemPrompt: null,
      trunkBranchId: 'trunk',
      createdAt: T,
      updatedAt: T,
    },
    branches: [trunk],
    nodes: [reply],
    links: [],
  };
}

/** The branch dialog opened on `a1`, for a user with `status` and these provider entries. */
async function open(status: MembershipInfo['status'], providers: ProviderInfo[]) {
  const api = {
    me: vi.fn(async () => ({}) as MeResponse),
    providers: vi.fn(async () => providers),
    listTrees: vi.fn(async () => []),
    keyStatus: vi.fn(async () => ({ enabled: true, hasKey: false, providers: [] })),
    billing: vi.fn(async () => ({ availableMicros: 2_000_000 }) as BillingSummary),
    poolStatus: vi.fn(async () => ({ enabled: false }) as PoolStatusResponse),
  };
  const injector = Injector.create({
    providers: [
      { provide: CanvasStore },
      { provide: UiStore },
      { provide: ComposerController },
      { provide: ToastStore },
      { provide: ApiClient, useValue: api },
      { provide: Router, useValue: { navigate: vi.fn(async () => true) } },
    ],
  });
  const store = injector.get(CanvasStore);
  await store.init({
    builtInCredit: true,
    membership: membership(status),
    membershipNeededFor: ['own-key'],
  } as MeResponse);
  store.detail.set(tree());
  const d = runInInjectionContext(injector, () => new BranchDialog());
  Object.defineProperty(d, 'state', { value: signal({ fromNodeId: 'a1', quote: null }) });
  d.ngOnInit();
  return { store, rows: d['variants']() };
}

describe('Canvas branch dialog: the route a new lane starts on', () => {
  it('a usable parent lane: its own route and model', async () => {
    const { rows } = await open('active', [ownKey, credit]);
    expect(rows[0]).toMatchObject({
      providerId: 'openrouter',
      funding: 'own-key',
      model: 'vendor/x',
    });
  });

  it('a parent lane locked by the membership: the default route, keeping a model it serves', async () => {
    const { store, rows } = await open('inactive', [ownKey, credit]);
    expect(store.account.defaultProvider()).toBe(credit);
    expect(rows[0]).toMatchObject({
      providerId: 'openrouter',
      funding: 'credit',
      model: 'vendor/x',
    });
  });

  it('a parent lane whose own key is missing here: the default route', async () => {
    const noKey = { ...ownKey, available: false, keySource: null };
    const { store, rows } = await open('active', [noKey, credit]);
    expect(store.account.defaultProvider()).toBe(credit);
    expect(rows[0]).toMatchObject({ funding: 'credit' });
  });
});
