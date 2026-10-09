import type { z } from './zod.js';
import {
  adminCreditRequestSchema,
  adminPoolUsageQuerySchema,
  adminUsersQuerySchema,
  updateAdminUserRequestSchema,
  type AdminCreditResponse,
  type AdminPoolResponse,
  type AdminPoolUsageResponse,
  type AdminStatusResponse,
  type AdminUser,
  type AdminUsersResponse,
} from './admin.js';
import {
  contextQuerySchema,
  createBranchRequestSchema,
  createLinkRequestSchema,
  createShareRequestSchema,
  createTreeRequestSchema,
  deleteAccountRequestSchema,
  exportQuerySchema,
  forgetKeyRequestSchema,
  saveKeyRequestSchema,
  sendMessageRequestSchema,
  treeBackupSchema,
  updateBranchRequestSchema,
  updateLinkRequestSchema,
  updateSettingsRequestSchema,
  updateShareRequestSchema,
  updateTreeRequestSchema,
  usageQuerySchema,
  type ContextPlanResponse,
  type CopyToLearnResponse,
  type DeleteBranchResponse,
  type KeyStatusResponse,
  type LoginOptionsResponse,
  type MeResponse,
  type SettingsResponse,
  type ShareSummary,
  type StreamEvent,
  type TreeBackup,
  type TreeDetail,
  type TreeSummary,
} from './api.js';
import {
  createCheckoutRequestSchema,
  membershipWaiverRequestSchema,
  type BillingSummary,
  type CheckoutResponse,
  type MembershipInfo,
  type PortalResponse,
  type UsageListResponse,
} from './billing.js';
import {
  candidateRequestSchema,
  type CandidateEvent,
  type CommitCandidateResponse,
} from './compare.js';
import type { Branch, NodeLink, Tree } from './domain.js';
import type { InputBudgetResponse } from './input-limit.js';
import {
  poolVerifyRequestSchema,
  type PoolMeResponse,
  type PoolStatusResponse,
  type PoolVerifyResponse,
} from './pool.js';
import type { ProviderInfo } from './provider.js';
import { reviewRequestSchema, type ReviewEvent } from './review.js';

/*
 * The HTTP API between the apps and the Worker, one entry per route: its
 * method, its path under /api (`:name` marks a path parameter), the zod
 * schemas the Worker validates its JSON body and query with, and what it
 * answers. The apps' ApiClient calls routes from here, the demos' backend
 * must answer or refuse each one, and a Worker test checks that its Hono
 * app serves exactly these. Every other `/api/*` path is Better Auth's
 * (`/api/auth/*`) or a payment provider's webhook.
 *
 * Unless a route says otherwise it needs a session, and acts as the
 * caller's account for the app named by the MODE_HEADER (power when
 * absent); Learn requests also send the PAYMENT_HEADER (billing.ts). Writes
 * must be same-origin. Errors answer with the ApiError body (api.ts).
 * Generating routes (messages, review, candidates, `context?resolve=true`)
 * pass the billing gate first: 402 `membership_required` on the user's own
 * keys without a required membership, 402 `payment_required` on too little
 * Tangent credit, and the open pool's 402/429/403 refusals (pool.ts).
 */

/** JSON of type `T`, 200 or 201. */
export interface JsonReply<T> {
  readonly kind: 'json';
  /** Only carries the type; never set. */
  readonly type?: T;
}
/** 204, no body. */
export interface EmptyReply {
  readonly kind: 'empty';
}
/** `text/event-stream` of `E` frames (`event: <type>\ndata: <JSON>\n\n`). */
export interface StreamReply<E> {
  readonly kind: 'stream';
  /** Only carries the type; never set. */
  readonly event?: E;
}
/** A file download (Content-Disposition: attachment). */
export interface FileReply {
  readonly kind: 'file';
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface RouteSpec {
  readonly method: HttpMethod;
  /** Under `/api`; `:name` is a path parameter. */
  readonly path: string;
  readonly body?: z.ZodType;
  readonly query?: z.ZodType;
  readonly reply: JsonReply<unknown> | EmptyReply | StreamReply<unknown> | FileReply;
}

const json = <T>(): JsonReply<T> => ({ kind: 'json' });
const empty: EmptyReply = { kind: 'empty' };
const stream = <E>(): StreamReply<E> => ({ kind: 'stream' });
const file: FileReply = { kind: 'file' };

export const API_ROUTES = {
  // Public: what the login page offers.
  loginOptions: { method: 'GET', path: '/login-options', reply: json<LoginOptionsResponse>() },
  me: { method: 'GET', path: '/me', reply: json<MeResponse>() },
  /** Both of the user's accounts, for good; same-origin only, and clears the cookies. */
  deleteAccount: {
    method: 'DELETE',
    path: '/account',
    body: deleteAccountRequestSchema,
    reply: empty,
  },
  providers: { method: 'GET', path: '/providers', reply: json<ProviderInfo[]>() },

  // Bring-your-own-key: the key is only ever accepted, and lives in a sealed HttpOnly cookie.
  keyStatus: { method: 'GET', path: '/key/status', reply: json<KeyStatusResponse>() },
  saveKey: { method: 'POST', path: '/key', body: saveKeyRequestSchema, reply: empty },
  forgetKey: { method: 'DELETE', path: '/key', body: forgetKeyRequestSchema, reply: empty },

  // Billing: the membership and the credit are the user's, in both apps.
  billing: { method: 'GET', path: '/billing', reply: json<BillingSummary>() },
  usage: {
    method: 'GET',
    path: '/billing/usage',
    query: usageQuerySchema,
    reply: json<UsageListResponse>(),
  },
  createCheckout: {
    method: 'POST',
    path: '/billing/checkout',
    body: createCheckoutRequestSchema,
    reply: json<CheckoutResponse>(),
  },
  /** The membership's hosted checkout, or the billing portal for a user who already pays. */
  membershipCheckout: {
    method: 'POST',
    path: '/billing/membership/checkout',
    reply: json<CheckoutResponse>(),
  },
  /** 400 without a code on the server, 403 a wrong code, 429 too many tries. */
  redeemMembershipWaiver: {
    method: 'POST',
    path: '/billing/membership/waiver',
    body: membershipWaiverRequestSchema,
    reply: json<MembershipInfo>(),
  },
  /** 404 `no_customer` while the payment provider has no customer for the user. */
  billingPortal: { method: 'POST', path: '/billing/portal', reply: json<PortalResponse>() },

  // The open pool.
  /** Public: the pool meter, aggregates only, edge-cached. */
  poolStatus: { method: 'GET', path: '/pool/status', reply: json<PoolStatusResponse>() },
  poolMe: { method: 'GET', path: '/pool/me', reply: json<PoolMeResponse>() },
  /** The first-use Turnstile check (the Worker's /verify page). */
  poolVerify: {
    method: 'POST',
    path: '/pool/verify',
    body: poolVerifyRequestSchema,
    reply: json<PoolVerifyResponse>(),
  },

  settings: { method: 'GET', path: '/settings', reply: json<SettingsResponse>() },
  updateSettings: {
    method: 'PATCH',
    path: '/settings',
    body: updateSettingsRequestSchema,
    reply: json<SettingsResponse>(),
  },

  // Trees, branches and links.
  listTrees: { method: 'GET', path: '/trees', reply: json<TreeSummary[]>() },
  createTree: {
    method: 'POST',
    path: '/trees',
    body: createTreeRequestSchema,
    reply: json<TreeDetail>(),
  },
  getTree: { method: 'GET', path: '/trees/:treeId', reply: json<TreeDetail>() },
  updateTree: {
    method: 'PATCH',
    path: '/trees/:treeId',
    body: updateTreeRequestSchema,
    reply: json<Tree>(),
  },
  deleteTree: { method: 'DELETE', path: '/trees/:treeId', reply: empty },
  createBranch: {
    method: 'POST',
    path: '/branches',
    body: createBranchRequestSchema,
    reply: json<Branch>(),
  },
  updateBranch: {
    method: 'PATCH',
    path: '/branches/:branchId',
    body: updateBranchRequestSchema,
    reply: json<Branch>(),
  },
  /** The branch and every branch below it; not the trunk. */
  deleteBranch: {
    method: 'DELETE',
    path: '/branches/:branchId',
    reply: json<DeleteBranchResponse>(),
  },
  /** `resolve=true` generates missing summaries (and passes the gate). */
  getContext: {
    method: 'GET',
    path: '/branches/:branchId/context',
    query: contextQuerySchema,
    reply: json<ContextPlanResponse>(),
  },
  inputBudget: {
    method: 'GET',
    path: '/branches/:branchId/input-budget',
    reply: json<InputBudgetResponse>(),
  },
  /** 201 with the new link; 200 with the existing one when the two messages are linked already. */
  createLink: {
    method: 'POST',
    path: '/links',
    body: createLinkRequestSchema,
    reply: json<NodeLink>(),
  },
  updateLink: {
    method: 'PATCH',
    path: '/links/:linkId',
    body: updateLinkRequestSchema,
    reply: json<NodeLink>(),
  },
  deleteLink: { method: 'DELETE', path: '/links/:linkId', reply: empty },

  // Generating.
  sendMessage: {
    method: 'POST',
    path: '/branches/:branchId/messages',
    body: sendMessageRequestSchema,
    reply: stream<StreamEvent>(),
  },
  /** Reconnect: `snapshot`, then the live events. */
  streamNode: { method: 'GET', path: '/nodes/:nodeId/stream', reply: stream<StreamEvent>() },
  cancelNode: { method: 'POST', path: '/nodes/:nodeId/cancel', reply: empty },
  reviewNode: {
    method: 'POST',
    path: '/nodes/:nodeId/review',
    body: reviewRequestSchema,
    reply: stream<ReviewEvent>(),
  },
  /** Compare: one model's candidate answer; nothing is stored until it is committed. */
  streamCandidate: {
    method: 'POST',
    path: '/branches/:branchId/candidates',
    body: candidateRequestSchema,
    reply: stream<CandidateEvent>(),
  },
  /** 404 unknown, 409 the branch moved on, 410 expired, 403 on the pool. */
  commitCandidate: {
    method: 'POST',
    path: '/branches/:branchId/candidates/:candidateId/commit',
    reply: json<CommitCandidateResponse>(),
  },

  // Share links (the public pages are /s/*).
  listShares: { method: 'GET', path: '/shares', reply: json<ShareSummary[]>() },
  createShare: {
    method: 'POST',
    path: '/shares',
    body: createShareRequestSchema,
    reply: json<ShareSummary>(),
  },
  updateShare: {
    method: 'PATCH',
    path: '/shares/:shareId',
    body: updateShareRequestSchema,
    reply: json<ShareSummary>(),
  },
  republishShare: {
    method: 'POST',
    path: '/shares/:shareId/republish',
    reply: json<ShareSummary>(),
  },
  revokeShare: { method: 'POST', path: '/shares/:shareId/revoke', reply: json<ShareSummary>() },
  /** The link 404s from then on. */
  deleteShare: { method: 'DELETE', path: '/shares/:shareId', reply: empty },

  // A tree out of and into the account.
  exportTree: { method: 'GET', path: '/export', query: exportQuerySchema, reply: file },
  /** JSON, also offered as a download. */
  backup: { method: 'GET', path: '/trees/:treeId/backup', reply: json<TreeBackup>() },
  /** A new tree with new ids. */
  importBackup: {
    method: 'POST',
    path: '/import',
    body: treeBackupSchema,
    reply: json<TreeDetail>(),
  },
  /** A power tree into the same user's Learn account; power only. */
  copyToLearn: {
    method: 'POST',
    path: '/trees/:treeId/copy-to-learn',
    reply: json<CopyToLearnResponse>(),
  },

  // Admin: admins only, `not_found` to anyone else.
  adminStatus: { method: 'GET', path: '/admin/status', reply: json<AdminStatusResponse>() },
  adminUsers: {
    method: 'GET',
    path: '/admin/users',
    query: adminUsersQuerySchema,
    reply: json<AdminUsersResponse>(),
  },
  updateAdminUser: {
    method: 'PATCH',
    path: '/admin/users/:userId',
    body: updateAdminUserRequestSchema,
    reply: json<AdminUser>(),
  },
  adminUserShares: {
    method: 'GET',
    path: '/admin/users/:userId/shares',
    reply: json<ShareSummary[]>(),
  },
  adminPool: { method: 'GET', path: '/admin/pool', reply: json<AdminPoolResponse>() },
  adminPoolUsage: {
    method: 'GET',
    path: '/admin/pool/usage',
    query: adminPoolUsageQuerySchema,
    reply: json<AdminPoolUsageResponse>(),
  },
  /** Idempotent on `idempotencyKey`; simulated purchases 404 unless DEV_PURCHASES_ENABLED. */
  adminCredit: {
    method: 'POST',
    path: '/admin/credit',
    body: adminCreditRequestSchema,
    reply: json<AdminCreditResponse>(),
  },
  /** Any owner's share (a takedown). */
  adminRevokeShare: {
    method: 'POST',
    path: '/admin/shares/:shareId/revoke',
    reply: json<ShareSummary>(),
  },
} as const satisfies Record<string, RouteSpec>;

export type ApiRoutes = typeof API_ROUTES;
export type RouteName = keyof ApiRoutes;
export type ApiRoute = ApiRoutes[RouteName];

const isRouteName = (name: string): name is RouteName => Object.hasOwn(API_ROUTES, name);
/** Every route's name, in the table's order. */
export const ROUTE_NAMES: readonly RouteName[] = Object.keys(API_ROUTES).filter(isRouteName);

type ParamNames<P extends string> = P extends `${string}:${infer N}/${infer Rest}`
  ? N | ParamNames<Rest>
  : P extends `${string}:${infer N}`
    ? N
    : never;

/** `{ treeId: string }` for `/trees/:treeId`. */
export type RouteParams<R extends RouteSpec> = { readonly [K in ParamNames<R['path']>]: string };

/** A route's JSON body as a client sends it. */
export type RouteBody<R extends RouteSpec> = R extends { body: z.ZodType }
  ? z.input<R['body']>
  : never;

/** A route's query as a client sends it: the schema's keys, any absent or null one left out. */
export type RouteQuery<R extends RouteSpec> = R extends { query: z.ZodType }
  ? { readonly [K in keyof z.input<R['query']>]?: string | number | boolean | null }
  : never;

/** What a JSON or empty route resolves with. */
export type RouteReply<R extends RouteSpec> =
  R['reply'] extends JsonReply<infer T> ? T : R['reply'] extends EmptyReply ? undefined : never;

/** What a stream route's frames carry. */
export type RouteEvent<R extends RouteSpec> = R['reply'] extends StreamReply<infer E> ? E : never;

type NoInput = Record<never, never>;

/** What a call of `route` needs: its path parameters, its body, its query (optional). */
export type RouteInput<R extends RouteSpec> = ([ParamNames<R['path']>] extends [never]
  ? NoInput
  : { params: RouteParams<R> }) &
  (R extends { body: z.ZodType } ? { body: RouteBody<R> } : NoInput) &
  (R extends { query: z.ZodType } ? { query?: RouteQuery<R> } : NoInput);

/** The URL of `route` (`/api/...`), its parameters encoded and its query in the given order. */
export function routeUrl(
  route: RouteSpec,
  params: Readonly<Record<string, string>> = {},
  query: Readonly<Record<string, string | number | boolean | null | undefined>> = {},
): string {
  const path = route.path.replace(/:(\w+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`${route.path} needs :${name}`);
    return encodeURIComponent(value);
  });
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) q.set(key, String(value));
  }
  const qs = q.toString();
  return `/api${path}${qs ? `?${qs}` : ''}`;
}

/** The names of `route`'s path parameters, in order. */
function paramNames(route: RouteSpec): string[] {
  return [...route.path.matchAll(/:(\w+)/g)].map((m) => m[1] ?? '');
}

/** Whether `params` holds every path parameter of `route`. */
function hasParams<R extends RouteSpec>(
  route: R,
  params: Readonly<Record<string, string>>,
): params is RouteParams<R> {
  return paramNames(route).every((name) => name in params);
}

/**
 * The path parameters of `pathname` (`/api/...`), decoded, when it is
 * `route`'s path; null when it isn't. The table's paths hold no regex
 * syntax, only words, `-`, `/` and parameters.
 */
export function matchRoute<R extends RouteSpec>(route: R, pathname: string): RouteParams<R> | null {
  const m = new RegExp(`^/api${route.path.replace(/:\w+/g, '([^/]+)')}$`).exec(pathname);
  if (!m) return null;
  const params: Record<string, string> = {};
  paramNames(route).forEach((name, i) => (params[name] = decodeURIComponent(m[i + 1] ?? '')));
  return hasParams(route, params) ? params : null;
}
