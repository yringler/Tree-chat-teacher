import type { EnvironmentProviders, Provider, Type } from '@angular/core';
import type {
  BillingSummary,
  MembershipInfo,
  MeResponse,
  ProviderInfo,
  TreeDetail,
} from '@tangent/shared';
import { ApiClient } from '../core/api-client';
import type { ConversationStore } from '../conversation/conversation-store';
import { DEMO_MODE } from '../core/demo';
import { provideTextSize } from '../core/text-size-store';
import type { PowerAccountStore } from '../power/power-account';
import { PowerConversationStore } from '../power/power-conversation-store';
import { membership, provider } from './fixtures';
import { provideAnyRoute } from './render';

/**
 * What an app's component needs around it: `api` (a stub of the calls the
 * spec expects) as the ApiClient, a text size and a router.
 */
export function appProviders(api: object): (Provider | EnvironmentProviders)[] {
  return [
    { provide: ApiClient, useValue: api },
    { provide: DEMO_MODE, useValue: false },
    provideTextSize('tangent.test.textSize'),
    provideAnyRoute(),
  ];
}

/** `appProviders`, with the power or canvas store as the shared dialogs' `PowerConversationStore`. */
export function powerProviders(
  store: Type<PowerConversationStore>,
  api: object,
): (Provider | EnvironmentProviders)[] {
  return [...appProviders(api), { provide: PowerConversationStore, useExisting: store }];
}

/** The signed-in user. */
export function me(over: Partial<MeResponse> = {}): MeResponse {
  return {
    email: 'a@example.com',
    userId: '1',
    accountId: 'p_1',
    mode: 'power',
    devMode: false,
    operatorKeys: false,
    builtInCredit: false,
    sharing: true,
    isAdmin: false,
    membership: membership(),
    membershipNeededFor: ['own-key'],
    ...over,
  };
}

/**
 * Signs `account` in as `/api/me` and the provider list would: a member
 * with the own OpenRouter key saved unless `opts` says otherwise.
 */
export function signIn(
  account: PowerAccountStore,
  opts: {
    membership?: MembershipInfo;
    providers?: ProviderInfo[];
    builtInCredit?: boolean;
    billing?: BillingSummary;
  } = {},
): void {
  const m = opts.membership ?? membership();
  account.me.set(me({ membership: m, builtInCredit: opts.builtInCredit ?? false }));
  account.membership.set(m);
  account.membershipNeededFor.set(['own-key']);
  account.providers.set(opts.providers ?? [provider()]);
  account.providersLoaded.set(true);
  if (opts.billing) account.billing.set(opts.billing);
}

/** Opens `d` in `store` (no fetch: it is the tree already loaded), on `branchId` (the trunk). */
export function openTree(
  store: Pick<ConversationStore, 'selectedTreeId' | 'detail' | 'setRoute'>,
  d: TreeDetail,
  branchId: string | null = null,
): void {
  store.selectedTreeId.set(d.tree.id);
  store.detail.set(d);
  store.setRoute(d.tree.id, branchId, null);
}
