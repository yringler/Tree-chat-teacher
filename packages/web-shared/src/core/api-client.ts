import { inject, Injectable } from '@angular/core';
import type {
  AdminPoolUsageResponse,
  AdminStatusResponse,
  AdminUser,
  AdminUsersResponse,
  ApiError as ApiErrorBody,
  ApiErrorCode,
  BillingSummary,
  Branch,
  CheckoutResponse,
  CreateCheckoutRequest,
  ContextPlanResponse,
  CreateBranchRequest,
  CreateShareRequest,
  CreateTreeRequest,
  DeleteAccountRequest,
  DeleteBranchResponse,
  KeyStatusResponse,
  MembershipInfo,
  MembershipWaiverRequest,
  MeResponse,
  PoolBlockDetails,
  PoolConsentDetails,
  PoolConsentRequest,
  PoolConsentResponse,
  PoolMeResponse,
  PoolStatusResponse,
  ProviderInfo,
  PurchaseTarget,
  ReviewRequest,
  SendMessageRequest,
  SettingsResponse,
  ShareScope,
  ShareSummary,
  Tree,
  TreeBackupInput,
  TreeDetail,
  TreeSummary,
  UpdateAdminUserRequest,
  UpdateBranchRequest,
  UpdateSettingsRequest,
  UpdateShareRequest,
  UpdateTreeRequest,
  UsageListResponse,
} from '@tangent/shared';
import { API_FETCH, API_HEADERS, defaultApiFetch } from './api-fetch';

/**
 * Thrown for every non-2xx API response (and for network failures, with
 * status 0). `pool` carries what a community pool refusal hit (`pool_*` codes);
 * `consent` the pool notice version to acknowledge (`pool_consent_required`).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | 'network',
    message: string,
    readonly pool: PoolBlockDetails | null = null,
    readonly consent: PoolConsentDetails | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ExportParams {
  treeId: string;
  scope: ShareScope;
  nodeId?: string | null;
  format: 'md' | 'html';
  includeAncestors?: boolean;
  includePrivate?: boolean;
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const err = value.error;
  return (
    typeof err === 'object' && err !== null && 'message' in err && typeof err.message === 'string'
  );
}

const enc = encodeURIComponent;

/** Error code for a non-2xx response without our JSON error body (e.g. a proxy page). */
function fallbackCode(status: number): ApiErrorCode {
  if (status === 402) return 'payment_required';
  return status >= 500 ? 'internal' : 'bad_request';
}

/** Typed fetch wrapper for the owner API (`/api/*`), over the API_FETCH transport. */
@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly base = '/api';
  /** Optional so a bare `Injector.create` (tests) falls back to the global fetch. */
  private readonly transport = inject(API_FETCH, { optional: true }) ?? defaultApiFetch;
  private readonly extraHeaders = inject(API_HEADERS, { optional: true }) ?? (() => ({}));

  me(): Promise<MeResponse> {
    return this.json('GET', '/me');
  }

  /** Permanently deletes the signed-in user (both accounts); `confirmEmail` must be their email. */
  deleteAccount(confirmEmail: string): Promise<void> {
    return this.json('DELETE', '/account', { confirmEmail } satisfies DeleteAccountRequest);
  }

  providers(): Promise<ProviderInfo[]> {
    return this.json('GET', '/providers');
  }

  // Bring-your-own-key. The key goes to the Worker once and comes back only
  // as a sealed HttpOnly cookie that this code can't read.

  keyStatus(): Promise<KeyStatusResponse> {
    return this.json('GET', '/key/status');
  }

  saveKey(provider: string, apiKey: string): Promise<void> {
    return this.json('POST', '/key', { provider, apiKey });
  }

  /** Omit `provider` to forget every stored key. */
  forgetKey(provider?: string): Promise<void> {
    return this.json('DELETE', '/key', provider ? { provider } : {});
  }

  // Billing (both apps: the membership and the credit are per user)

  billing(): Promise<BillingSummary> {
    return this.json('GET', '/billing');
  }

  /** One page of metered usage, newest first. Pass the previous page's `nextCursor` for the next. */
  usage(cursor?: string | null, limit?: number): Promise<UsageListResponse> {
    const q = new URLSearchParams();
    if (cursor) q.set('cursor', cursor);
    if (limit !== undefined) q.set('limit', String(limit));
    const qs = q.toString();
    return this.json('GET', qs ? `/billing/usage?${qs}` : '/billing/usage');
  }

  /**
   * Starts a one-time credit purchase, for the caller (`personal`, a top-up)
   * or for the community pool; resolves with the Stripe Checkout URL to send
   * the browser to.
   */
  createCheckout(
    amountCents: number,
    target: PurchaseTarget = 'personal',
  ): Promise<CheckoutResponse> {
    return this.json('POST', '/billing/checkout', {
      amountCents,
      ...(target === 'pool' ? { target } : {}),
    } satisfies CreateCheckoutRequest);
  }

  // The community pool

  /** The pool meter (public; cached for a minute). */
  poolStatus(): Promise<PoolStatusResponse> {
    return this.json('GET', '/pool/status');
  }

  /** The caller's caps and use of the pool today. */
  poolMe(): Promise<PoolMeResponse> {
    return this.json('GET', '/pool/me');
  }

  /**
   * Acknowledges the pool notice at `version` (the one shown); a version that
   * is no longer current is 409 `conflict`.
   */
  poolConsent(version: number): Promise<PoolConsentResponse> {
    return this.json('POST', '/pool/consent', { version } satisfies PoolConsentRequest);
  }

  /**
   * Redeems the operator's code to waive the membership fee; resolves with the
   * new membership. A wrong code is 403 `forbidden`, too many tries 429
   * `rate_limited`, and a server without a code 400 `bad_request`.
   */
  redeemMembershipWaiver(code: string): Promise<MembershipInfo> {
    return this.json('POST', '/billing/membership/waiver', {
      code,
    } satisfies MembershipWaiverRequest);
  }

  // Account settings (server-side, per account)

  /** The account's saved settings and the built-in default system prompt. */
  settings(): Promise<SettingsResponse> {
    return this.json('GET', '/settings');
  }

  /** `systemPrompt: null` (or blank) goes back to the built-in default. */
  updateSettings(req: UpdateSettingsRequest): Promise<SettingsResponse> {
    return this.json('PATCH', '/settings', req);
  }

  // Trees

  listTrees(): Promise<TreeSummary[]> {
    return this.json('GET', '/trees');
  }

  createTree(req: CreateTreeRequest): Promise<TreeDetail> {
    return this.json('POST', '/trees', req);
  }

  getTree(treeId: string): Promise<TreeDetail> {
    return this.json('GET', `/trees/${enc(treeId)}`);
  }

  updateTree(treeId: string, req: UpdateTreeRequest): Promise<Tree> {
    return this.json('PATCH', `/trees/${enc(treeId)}`, req);
  }

  deleteTree(treeId: string): Promise<void> {
    return this.json('DELETE', `/trees/${enc(treeId)}`);
  }

  // Branches

  createBranch(req: CreateBranchRequest): Promise<Branch> {
    return this.json('POST', '/branches', req);
  }

  updateBranch(branchId: string, req: UpdateBranchRequest): Promise<Branch> {
    return this.json('PATCH', `/branches/${enc(branchId)}`, req);
  }

  deleteBranch(branchId: string): Promise<DeleteBranchResponse> {
    return this.json('DELETE', `/branches/${enc(branchId)}`);
  }

  getContext(
    branchId: string,
    nodeId: string | null,
    resolve: boolean,
  ): Promise<ContextPlanResponse> {
    const q = new URLSearchParams();
    if (nodeId) q.set('nodeId', nodeId);
    q.set('resolve', String(resolve));
    return this.json('GET', `/branches/${enc(branchId)}/context?${q.toString()}`);
  }

  // Streaming

  /** POST a message; resolves with the open `text/event-stream` response. */
  sendMessage(branchId: string, req: SendMessageRequest, signal: AbortSignal): Promise<Response> {
    return this.stream('POST', `/branches/${enc(branchId)}/messages`, req, signal);
  }

  /** Reconnect to a generation: `snapshot`, then live events. */
  streamNode(nodeId: string, signal: AbortSignal): Promise<Response> {
    return this.stream('GET', `/nodes/${enc(nodeId)}/stream`, undefined, signal);
  }

  cancelNode(nodeId: string): Promise<void> {
    return this.json('POST', `/nodes/${enc(nodeId)}/cancel`);
  }

  /** Review the conversation up to an assistant reply; resolves with the open event stream. */
  reviewNode(nodeId: string, req: ReviewRequest, signal: AbortSignal): Promise<Response> {
    return this.stream('POST', `/nodes/${enc(nodeId)}/review`, req, signal);
  }

  // Shares

  listShares(): Promise<ShareSummary[]> {
    return this.json('GET', '/shares');
  }

  createShare(req: CreateShareRequest): Promise<ShareSummary> {
    return this.json('POST', '/shares', req);
  }

  updateShare(shareId: string, req: UpdateShareRequest): Promise<ShareSummary> {
    return this.json('PATCH', `/shares/${enc(shareId)}`, req);
  }

  republishShare(shareId: string): Promise<ShareSummary> {
    return this.json('POST', `/shares/${enc(shareId)}/republish`);
  }

  revokeShare(shareId: string): Promise<ShareSummary> {
    return this.json('POST', `/shares/${enc(shareId)}/revoke`);
  }

  // Admin (the admin app; 404 for anyone but an admin)

  adminStatus(): Promise<AdminStatusResponse> {
    return this.json('GET', '/admin/status');
  }

  /** One page of users, newest first; `q` filters by email substring. */
  adminUsers(q?: string, cursor?: string | null): Promise<AdminUsersResponse> {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (cursor) params.set('cursor', cursor);
    const qs = params.toString();
    return this.json('GET', qs ? `/admin/users?${qs}` : '/admin/users');
  }

  updateAdminUser(userId: string, req: UpdateAdminUserRequest): Promise<AdminUser> {
    return this.json('PATCH', `/admin/users/${enc(userId)}`, req);
  }

  /** Pool consumption per user over the last `days`, most spend first, and today's busiest networks. */
  adminPoolUsage(days?: number): Promise<AdminPoolUsageResponse> {
    return this.json('GET', days ? `/admin/pool/usage?days=${days}` : '/admin/pool/usage');
  }

  adminUserShares(userId: string): Promise<ShareSummary[]> {
    return this.json('GET', `/admin/users/${enc(userId)}/shares`);
  }

  /** Revokes any user's share (a takedown). */
  adminRevokeShare(shareId: string): Promise<ShareSummary> {
    return this.json('POST', `/admin/shares/${enc(shareId)}/revoke`);
  }

  // Export / backup / import

  /** Download link for a Markdown or HTML export. */
  exportUrl(p: ExportParams): string {
    const q = new URLSearchParams({ treeId: p.treeId, scope: p.scope, format: p.format });
    if (p.scope !== 'tree' && p.nodeId) q.set('nodeId', p.nodeId);
    if (p.includeAncestors) q.set('includeAncestors', 'true');
    if (p.includePrivate) q.set('includePrivate', 'true');
    return `${this.base}/export?${q.toString()}`;
  }

  /** Download link for the JSON backup of one tree. */
  backupUrl(treeId: string): string {
    return `${this.base}/trees/${enc(treeId)}/backup`;
  }

  importBackup(backup: TreeBackupInput): Promise<TreeDetail> {
    return this.json('POST', '/import', backup);
  }

  // Plumbing

  private async request(
    method: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const init: RequestInit = {
      method,
      credentials: 'same-origin',
      headers: { ...this.extraHeaders(), accept: 'application/json, text/event-stream' },
    };
    if (signal) init.signal = signal;
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { ...init.headers, 'content-type': 'application/json' };
    }
    let res: Response;
    // Called detached: a provided bare `fetch` must not be invoked with `this` set.
    const transport = this.transport;
    try {
      res = await transport(this.base + path, init);
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new ApiError(0, 'network', err instanceof Error ? err.message : 'Network error');
    }
    if (res.status === 401) {
      throw new ApiError(
        401,
        'unauthorized',
        'Your session has expired. Reload the page to sign in again.',
      );
    }
    if (!res.ok) throw await this.toError(res);
    return res;
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.request(method, path, body);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async stream(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Response> {
    const res = await this.request(method, path, body, signal);
    if (!res.body) throw new ApiError(res.status, 'internal', 'Empty stream response');
    return res;
  }

  private async toError(res: Response): Promise<ApiError> {
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      // Not JSON (e.g. a proxy error page).
    }
    if (isErrorBody(parsed))
      return new ApiError(
        res.status,
        parsed.error.code,
        parsed.error.message,
        parsed.error.pool ?? null,
        parsed.error.consent ?? null,
      );
    return new ApiError(res.status, fallbackCode(res.status), `${res.status} ${res.statusText}`);
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** True for a 402 `payment_required` ApiError (out of credit for the built-in provider). */
export function isPaymentRequired(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'payment_required';
}

/** True for a 402 `membership_required` ApiError (generating needs the yearly membership). */
export function isMembershipRequired(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'membership_required';
}

/** True for a 402 `pool_empty`: the community pool can't cover a request right now. */
export function isPoolEmpty(err: unknown): err is ApiError {
  return err instanceof ApiError && err.code === 'pool_empty';
}

/** True for a 429 `pool_cap_reached`: a daily pool cap or per-minute limit (`err.pool` says which). */
export function isPoolCapReached(err: unknown): err is ApiError {
  return err instanceof ApiError && err.code === 'pool_cap_reached';
}

/** True for a 403 `pool_consent_required`: the current pool notice must be acknowledged first. */
export function isPoolConsentRequired(err: unknown): err is ApiError {
  return err instanceof ApiError && err.code === 'pool_consent_required';
}

/** True for a 403 `pool_unavailable`: this request or account can't use the pool (`err.pool?.reason`). */
export function isPoolUnavailable(err: unknown): err is ApiError {
  return err instanceof ApiError && err.code === 'pool_unavailable';
}
