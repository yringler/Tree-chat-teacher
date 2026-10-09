import {
  appChatSettings,
  ChatService,
  DEFAULT_GROUNDING_POLICY,
  DomainError,
  GenerationHub,
  HTTP_STATUS,
  newId,
  replayEvents,
  systemClock,
  type BeginSendResult,
  type Clock,
  type GenerationLimits,
  type GenerationSink,
  type HeldCandidate,
} from '@tangent/core';
import { createMemoryRepositories, type MemoryState } from '@tangent/core/memory';
import {
  API_ROUTES,
  CANDIDATE_TTL_MS,
  matchRoute,
  ROUTE_NAMES,
  type ApiRoutes,
  type RouteName,
  type RouteParams,
  type RouteSpec,
  chargeMicros,
  costUsdToNanos,
  DEFAULT_BUILT_IN_MAX_INPUT_TOKENS,
  DEFAULT_MARKUP_BPS,
  DEFAULT_OPENROUTER_FEE_BPS,
  DEFAULT_SYSTEM_PROMPT,
  MAX_TOP_UP_CENTS,
  MICROS_PER_USD,
  MIN_TOP_UP_CENTS,
  type ApiError,
  type AccountMode,
  type ApiErrorCode,
  type BillingSummary,
  type Branch,
  type CandidateEvent,
  type ChatNode,
  type GenerateRequest,
  type InputBudgetResponse,
  type KeyStatusResponse,
  type LlmProvider,
  type LoginOptionsResponse,
  type MeResponse,
  type MembershipInfo,
  MAX_USAGE_FACTOR_FALLBACK,
  errorKindOf,
  REPLY_INTERRUPTED_ERROR,
  type NodeLink,
  type PoolMeResponse,
  type PoolStatusResponse,
  type ProviderEvent,
  type ProviderInfo,
  type ProviderRegistry,
  type ReviewEvent,
  type StreamEvent,
  type SummaryRecord,
  type Tree,
  type UsageEntry,
  type UsageListResponse,
  usageFactorOf,
} from '@tangent/shared';
import { seedDemoLesson } from './seed';
import { createLoremProvider, DEMO_MODEL_PRICES } from './lorem';

/*
 * The demos' backend, in the browser: a `fetch` replacement that answers
 * the `/api/*` routes the apps use, on top of the real ChatService with
 * in-memory repositories and the lorem provider. Branching, context
 * assembly, titles, summaries and reviews behave as in production; replies
 * are nonsense and nothing leaves the tab. One backend per app: the Learn
 * demo (`/learn/demo/`) acts as a simple account with pretend credit, the
 * Power demo (`/demo/`) as a power account; shares and keys aren't offered.
 *
 * Streaming runs on the Worker's TreeSession Durable Object's
 * GenerationHub: a generation runs detached from the request,
 * `GET /api/nodes/:id/stream` re-attaches with a `snapshot`, and cancel
 * aborts it (the stream ends with `error`).
 * Reviews and Compare's candidate answers stream straight back as in the
 * Worker; a finished candidate is held in memory (as the Durable Object
 * holds it) until it is committed or expires.
 */

export const DEMO_ACCOUNT_ID = 'demo';
export const DEMO_EMAIL = 'demo@example.com';
/** The demo's user id (shown as its Account ID). */
export const DEMO_USER_ID = 'demo-user';
/** Pretend credit the demo starts with ($4.20). */
export const DEMO_START_BALANCE_MICROS = 4_200_000;
/** The demos sell nothing: no membership is required. */
const DEMO_MEMBERSHIP: MembershipInfo = {
  required: false,
  status: 'inactive',
  subscriptionStatus: null,
  periodEnd: null,
  cancelAtPeriodEnd: false,
  priceCents: 1000,
};
/** The demos' pool: off, so no pool UI shows and nothing pretends to be funded. */
export const DEMO_POOL_STATUS: PoolStatusResponse = {
  enabled: false,
  availableMicros: 0,
  sessionsRemaining: 0,
  model: { id: 'lorem', label: 'Lite' },
};
const DEMO_POOL_ME: Omit<PoolMeResponse, 'personalAvailableMicros'> = {
  available: false,
  verified: true,
  suspended: false,
  caps: {
    requestsPerDay: 0,
    spendMicrosPerDay: 0,
    usedRequests: 0,
    usedSpendMicros: 0,
    resetAt: '1970-01-02T00:00:00.000Z',
  },
};
/** Held per in-flight provider call, like the real meter's reservation. */
const HOLD_MICROS = 20_000;
/** Per mode, so the two demos keep separate conversations (like the two real accounts). */
const STORAGE_KEYS: Readonly<Record<AccountMode, string>> = {
  simple: 'tangent.learn-demo',
  power: 'tangent.power-demo',
};

/** The bits of `Storage` the demo uses to survive a reload within the tab. */
export interface DemoStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface DemoBackendOptions {
  /** The account the demo acts as (default `simple`, the Learn demo). */
  mode?: AccountMode;
  /** Default: the lorem provider with 20–40 ms between words. */
  provider?: LlmProvider;
  clock?: Clock;
  /**
   * Where the session is mirrored (so a reload keeps it). Default
   * `sessionStorage` when the browser allows it; `null` keeps it in memory.
   */
  storage?: DemoStorage | null;
  /** Start with the example lesson (default true; ignored when a saved session is restored). */
  seed?: boolean;
}

/** A finished compare candidate, waiting to be committed (in memory only, like the DO's TTL'd storage). */
interface Held {
  candidate: HeldCandidate;
  /** Epoch ms. */
  expiresAt: number;
}

/** The shape of a mirrored session; a session saved in another shape is discarded. */
const SAVED_VERSION = 2;

interface Saved {
  version: typeof SAVED_VERSION;
  trees: Tree[];
  branches: Branch[];
  nodes: ChatNode[];
  links: NodeLink[];
  summaries: SummaryRecord[];
  balanceMicros: number;
  usage: UsageEntry[];
  /** The account's saved default system prompt (Settings). */
  systemPrompt: string | null;
}

const encoder = new TextEncoder();

/** One SSE frame, exactly as the Worker writes it (apps/worker/src/http/sse.ts). */
export function sseFrame(event: StreamEvent | ReviewEvent | CandidateEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function sseResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
    },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

function apiError(code: ApiErrorCode, message: string): Response {
  return json({ error: { code, message } } satisfies ApiError, HTTP_STATUS[code]);
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/** A zod error (thrown by the ChatService's request schemas) as a one-line message. */
function zodMessage(err: unknown): string | null {
  if (!(err instanceof Error) || err.name !== 'ZodError' || !('issues' in err)) return null;
  const issues = (err as { issues: { path: PropertyKey[]; message: string }[] }).issues;
  return (
    issues
      .slice(0, 5)
      .map((i) => (i.path.length ? `${i.path.map(String).join('.')}: ${i.message}` : i.message))
      .join('; ') || 'Invalid request'
  );
}

function defaultStorage(): DemoStorage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null; // storage blocked (privacy settings, sandboxed frame)
  }
}

const R = API_ROUTES;

/** What a demo handler gets: the route's path parameters, and the request's JSON body. */
interface DemoRequest<Route extends RouteSpec> {
  params: RouteParams<Route>;
  body: unknown;
  url: URL;
  signal: AbortSignal | null;
}

type DemoRoutes = {
  [N in RouteName]:
    ((request: DemoRequest<ApiRoutes[N]>) => Response | Promise<Response>) | 'unsupported';
};

/** The in-browser backend; `createDemoFetch` wraps it as a `fetch`. */
export class DemoBackend {
  private readonly repos = createMemoryRepositories();
  private readonly state: MemoryState = this.repos.dump();
  private readonly chat: ChatService;
  private readonly provider: LlmProvider;
  private readonly clock: Clock;
  private readonly storage: DemoStorage | null;
  private readonly mode: AccountMode;
  private readonly storageKey: string;
  private readonly hub = new GenerationHub();
  /** Compare candidates by id. */
  private readonly held = new Map<string, Held>();
  private balanceMicros = DEMO_START_BALANCE_MICROS;
  private heldMicros = 0;
  /** Newest first. */
  private usage: UsageEntry[] = [];
  /** Serializes sends and branch deletion (the Durable Object's send lock). */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(options: DemoBackendOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.mode = options.mode ?? 'simple';
    this.storageKey = STORAGE_KEYS[this.mode];
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    const inner = options.provider ?? createLoremProvider();
    this.provider = { ...inner, stream: (request) => this.meter(inner, request) };
    const provider = this.provider;
    const registry: ProviderRegistry = {
      get: (id) => (id === provider.id ? provider : undefined),
      list: () => [providerInfo(provider)],
      defaultProviderId: () => provider.id,
    };
    this.chat = new ChatService({
      repos: this.repos,
      accountId: DEMO_ACCOUNT_ID,
      providers: registry,
      // Like the Worker: Learn pays per request, so its branches are written `own-key`,
      // and imports are adapted to its provider, models, context and prompt.
      profile: { kind: this.mode === 'simple' ? 'learn' : 'power' },
      // As a server with the default config, summarizing on each branch's own route.
      settings: appChatSettings(this.mode === 'simple' ? 'learn' : 'power', {
        summaryProviderId: null,
        summaryModel: null,
        maxInputTokens: DEFAULT_BUILT_IN_MAX_INPUT_TOKENS,
        groundingPolicy: DEFAULT_GROUNDING_POLICY,
      }),
      // New conversations get the same built-in prompt as on the server (both modes).
      defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
      clock: this.clock,
    });
    if (!this.restore() && options.seed !== false) {
      this.usage = seedDemoLesson(this.state, {
        accountId: DEMO_ACCOUNT_ID,
        now: this.clock(),
        newId: () => newId(),
      });
    }
  }

  /** `fetch` over the demo routes; a request whose signal is already aborted rejects like fetch. */
  readonly fetch: typeof fetch = async (input, init = {}) => {
    const signal = init.signal ?? (input instanceof Request ? input.signal : null);
    if (signal?.aborted) throw abortError();
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, 'http://demo.invalid');
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    let body: unknown;
    if (typeof init.body === 'string' && init.body !== '') {
      try {
        body = JSON.parse(init.body);
      } catch {
        return apiError('bad_request', 'Malformed JSON in request body');
      }
    }
    try {
      return await this.route(method, url, body, signal ?? null);
    } catch (err) {
      if (err instanceof DomainError) return apiError(err.code, err.message);
      const zod = zodMessage(err);
      if (zod) return apiError('bad_request', zod);
      console.error('Demo backend error', method, url.pathname, err);
      return apiError('internal', 'Internal error');
    }
  };

  /**
   * What the demo answers on each route of the API table: a handler, or
   * `unsupported` (501 `not_implemented`). A record over every route name,
   * so a route added to the table doesn't compile until the demo decides.
   */
  private readonly routes: DemoRoutes = {
    loginOptions: () =>
      json({
        configured: false,
        devMode: false,
        social: { google: false, github: false },
        turnstileSiteKey: null,
      } satisfies LoginOptionsResponse),
    me: () =>
      json({
        email: DEMO_EMAIL,
        userId: DEMO_USER_ID,
        accountId: DEMO_ACCOUNT_ID,
        mode: this.mode,
        devMode: false,
        operatorKeys: true,
        builtInCredit: this.mode === 'simple',
        // The demo publishes nothing (its apps hide Share regardless).
        sharing: false,
        isAdmin: false,
        membership: { ...DEMO_MEMBERSHIP },
        // Nothing needs a membership here, so nothing is ever read-only.
        membershipNeededFor: [],
      } satisfies MeResponse),
    deleteAccount: 'unsupported',
    providers: () => json([withUsageFactor(providerInfo(this.provider))]),

    // Keys and shares (power): nothing stored, nothing published
    keyStatus: () =>
      json({ enabled: false, hasKey: false, providers: [] } satisfies KeyStatusResponse),
    saveKey: 'unsupported',
    forgetKey: 'unsupported',
    listShares: () => json([]),
    createShare: 'unsupported',
    updateShare: 'unsupported',
    republishShare: 'unsupported',
    revokeShare: 'unsupported',
    deleteShare: 'unsupported',

    // Billing (pretend credit; nothing can be bought)
    billing: () => json(this.billingSummary()),
    usage: ({ url }) => json(this.usagePage(url)),
    createCheckout: 'unsupported',
    membershipCheckout: 'unsupported',
    redeemMembershipWaiver: 'unsupported',
    billingPortal: 'unsupported',

    // The open pool: off in the demos (it runs on pretend credit and funds nothing)
    poolStatus: () => json(DEMO_POOL_STATUS),
    poolMe: () =>
      json({
        ...DEMO_POOL_ME,
        personalAvailableMicros: this.balanceMicros - this.heldMicros,
      } satisfies PoolMeResponse),
    poolVerify: 'unsupported',

    // Account settings (the default system prompt), kept with the session
    settings: async () => json(await this.chat.getSettings()),
    updateSettings: async ({ body }) =>
      this.saved(json(await this.chat.updateSettings(R.updateSettings.body.parse(body ?? {})))),

    // Trees (without a prompt in the request: the saved one, else the built-in one)
    listTrees: async () => json(await this.chat.listTrees()),
    createTree: async ({ body }) =>
      this.saved(json(await this.chat.createTree(R.createTree.body.parse(body ?? {})), 201)),
    getTree: async ({ params }) => json(await this.chat.getTreeDetail(params.treeId)),
    updateTree: async ({ params, body }) =>
      this.saved(
        json(await this.chat.updateTree(params.treeId, R.updateTree.body.parse(body ?? {}))),
      ),
    deleteTree: async ({ params: { treeId } }) => {
      await this.chat.getTreeDetail(treeId); // 404 before stopping anything
      await this.hub.stop((node) => node.treeId === treeId);
      await this.chat.deleteTree(treeId);
      return this.saved(noContent());
    },
    backup: async ({ params }) => json(await this.chat.exportBackup(params.treeId)),
    importBackup: async ({ body }) =>
      this.saved(json(await this.chat.importBackup(R.importBackup.body.parse(body ?? {})), 201)),
    // Offered only on a read-only power branch, which the demos never have (they
    // require no membership): the two demos stay apart.
    copyToLearn: 'unsupported',
    exportTree: 'unsupported',

    // Branches
    createBranch: async ({ body }) =>
      this.saved(json(await this.chat.createBranch(R.createBranch.body.parse(body ?? {})), 201)),
    updateBranch: async ({ params, body }) =>
      this.saved(
        json(await this.chat.updateBranch(params.branchId, R.updateBranch.body.parse(body ?? {}))),
      ),
    deleteBranch: async ({ params }) => this.saved(json(await this.deleteBranch(params.branchId))),
    getContext: async ({ params, url }) => {
      const { nodeId, resolve, ...limits } = R.getContext.query.parse(
        Object.fromEntries(url.searchParams),
      );
      const res = await this.chat.planContext(params.branchId, nodeId ?? null, {
        resolveSummaries: resolve,
        limits: this.powerLimits(limits),
      });
      return resolve ? this.saved(json(res)) : json(res);
    },
    inputBudget: async ({ params }) => json(await this.inputBudget(params.branchId)),

    // Links
    createLink: async ({ body }) => {
      const { link, created } = await this.chat.createLink(R.createLink.body.parse(body ?? {}));
      return this.saved(json(link, created ? 201 : 200));
    },
    updateLink: async ({ params, body }) =>
      this.saved(
        json(await this.chat.updateLink(params.linkId, R.updateLink.body.parse(body ?? {}))),
      ),
    deleteLink: async ({ params }) => {
      await this.chat.deleteLink(params.linkId);
      return this.saved(noContent());
    },

    // Messages and generations
    sendMessage: ({ params, body, signal }) => this.send(params.branchId, body, signal),
    streamNode: ({ params, signal }) => this.reconnect(params.nodeId, signal),
    cancelNode: async ({ params }) => {
      const node = await this.chat.getOwnedNode(params.nodeId);
      if (!this.hub.cancel(node.id)) await this.chat.recoverInterruptedNode(node.id);
      return noContent();
    },
    reviewNode: ({ params, body, signal }) => this.review(params.nodeId, body, signal),
    streamCandidate: ({ params, body, signal }) => this.candidate(params.branchId, body, signal),
    commitCandidate: ({ params }) => this.commitCandidate(params.branchId, params.candidateId),

    // Admin: the demos have no admin app
    adminStatus: 'unsupported',
    adminUsers: 'unsupported',
    updateAdminUser: 'unsupported',
    adminUserShares: 'unsupported',
    adminPool: 'unsupported',
    adminPoolUsage: 'unsupported',
    adminCredit: 'unsupported',
    adminRevokeShare: 'unsupported',
  };

  private async route(
    method: string,
    url: URL,
    body: unknown,
    signal: AbortSignal | null,
  ): Promise<Response> {
    // Better Auth's, outside the table: the apps sign out through it.
    if (method === 'POST' && url.pathname === '/api/auth/sign-out') return json({ success: true });
    for (const name of ROUTE_NAMES) {
      const res = this.answer(name, method, url, { body, url, signal });
      if (res) return res;
    }
    return apiError('not_found', 'Not available in the demo');
  }

  /** The answer of route `name` when the request is for it; null when it isn't. */
  private answer<N extends RouteName>(
    name: N,
    method: string,
    url: URL,
    request: Omit<DemoRequest<ApiRoutes[N]>, 'params'>,
  ): Response | Promise<Response> | null {
    const route = R[name];
    const params = route.method === method ? matchRoute(route, url.pathname) : null;
    if (!params) return null;
    const handler = this.routes[name];
    if (handler === 'unsupported')
      return apiError('not_implemented', "That isn't available in the demo.");
    return handler({ ...request, params });
  }

  // ------------------------------------------------------------ messages

  private async send(
    branchId: string,
    body: unknown,
    signal: AbortSignal | null,
  ): Promise<Response> {
    const { content, ground, ...requested } = R.sendMessage.body.parse(body ?? {});
    await this.chat.getOwnedBranch(branchId);
    if (this.outOfCredit()) return apiError('payment_required', 'Add credit to keep learning');
    const begin = this.lock.then(() => this.chat.beginSend(branchId, content));
    this.lock = begin.catch(() => undefined);
    const started: BeginSendResult = await begin;

    const options = {
      ...(ground === 'required' ? { ground } : {}),
      ...this.powerLimits(requested),
    };
    const { sink, response } = this.sseSink(started.assistantNode.id, signal);
    // Detached, like the Durable Object: keeps going when the reader goes away.
    void this.hub.start(
      started,
      sink,
      (aborted) => this.chat.runGeneration(started, aborted, options),
      { settle: () => this.save() },
    );
    this.save();
    return response;
  }

  /**
   * Power's reply length and input limit, as the Worker passes them on the
   * own key (apps/worker input-limit.ts); Learn ignores them.
   */
  private powerLimits(requested: GenerationLimits): GenerationLimits {
    if (this.mode !== 'power') return {};
    const { maxOutputTokens, maxInputTokens, inputOverflow } = requested;
    return {
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
      ...(inputOverflow === 'truncate' ? { inputOverflow } : {}),
    };
  }

  /** As the Worker's: the demo's own pretend prices, and no credit cap in power. */
  private async inputBudget(branchId: string): Promise<InputBudgetResponse> {
    const budget = await this.chat.inputBudget(branchId);
    const price = DEMO_MODEL_PRICES[budget.model];
    return {
      model: budget.model,
      funding: budget.funding,
      contextTokens: budget.contextTokens,
      maxOutputTokens: budget.maxOutputTokens,
      reasoning: budget.reasoning,
      serverMaxInputTokens: budget.maxInputTokens,
      price: price
        ? {
            inputUsdPerMTok: price.inMicrosPerMTok / MICROS_PER_USD,
            cacheReadUsdPerMTok: null,
            // Pretend list prices, with no fee or markup on top.
            basis: 'list' as const,
          }
        : null,
    };
  }

  /** A review streams straight back and stores nothing, as in the Worker. */
  private async review(
    nodeId: string,
    body: unknown,
    signal: AbortSignal | null,
  ): Promise<Response> {
    const req = R.reviewNode.body.parse(body ?? {});
    if (this.outOfCredit()) return apiError('payment_required', 'Add credit to keep learning');
    const prepared = await this.chat.prepareReview(nodeId, req, this.powerLimits(req));
    const controller = new AbortController();
    signal?.addEventListener('abort', () => controller.abort(), { once: true });
    const chat = this.chat;
    const events = chat.runReview(prepared, controller.signal)[Symbol.asyncIterator]();
    return sseResponse(
      new ReadableStream<Uint8Array>({
        async pull(c) {
          const next = await events.next();
          if (next.done) c.close();
          else c.enqueue(encoder.encode(sseFrame(next.value)));
        },
        cancel() {
          controller.abort();
        },
      }),
    );
  }

  /**
   * Compare: one model's answer streams straight back (like a review) and is
   * held once finished; nothing enters the tree until it is committed.
   */
  private async candidate(
    branchId: string,
    body: unknown,
    signal: AbortSignal | null,
  ): Promise<Response> {
    const req = R.streamCandidate.body.parse(body ?? {});
    if (this.outOfCredit()) return apiError('payment_required', 'Add credit to keep learning');
    const prepared = await this.chat.prepareCandidate(branchId, req, this.powerLimits(req));
    const controller = new AbortController();
    signal?.addEventListener('abort', () => controller.abort(), { once: true });
    const events = this.chat.runCandidate(prepared, controller.signal)[Symbol.asyncIterator]();
    const hold = (candidate: HeldCandidate): CandidateEvent => this.hold(candidate);
    const save = (): void => this.save();
    return sseResponse(
      new ReadableStream<Uint8Array>({
        async pull(c) {
          const next = await events.next();
          if (next.done) {
            save(); // the candidate's usage
            c.close();
            return;
          }
          const event = next.value;
          c.enqueue(
            encoder.encode(sseFrame(event.type === 'done' ? hold(event.candidate) : event)),
          );
        },
        async cancel() {
          // Run the aborted answer to its end, so the meter settles its hold.
          controller.abort();
          while (!(await events.next()).done);
          save();
        },
      }),
    );
  }

  /** Holds a finished candidate (pruning expired ones); returns the wire `done`. */
  private hold(candidate: HeldCandidate): CandidateEvent {
    const now = this.clock().getTime();
    for (const [key, h] of this.held) if (h.expiresAt <= now) this.held.delete(key);
    const expiresAt = now + CANDIDATE_TTL_MS;
    this.held.set(candidate.id, { candidate, expiresAt });
    return {
      type: 'done',
      candidateId: candidate.id,
      providerId: candidate.providerId,
      funding: candidate.funding,
      model: candidate.model,
      usage: candidate.usage,
      sources: candidate.sources,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /** Keeps one candidate: appends its exchange under the send lock and drops its siblings. */
  private async commitCandidate(branchId: string, candidateId: string): Promise<Response> {
    const held = this.held.get(candidateId);
    if (!held || held.expiresAt <= this.clock().getTime()) {
      this.held.delete(candidateId);
      return apiError('gone', 'That comparison has expired; ask again');
    }
    if (held.candidate.branchId !== branchId) return apiError('not_found', 'Candidate not found');
    const committed = this.lock.then(() => this.chat.commitCandidate(held.candidate));
    this.lock = committed.catch(() => undefined);
    const res = await committed;
    for (const [key, h] of this.held) {
      if (h.candidate.branchId === branchId && h.candidate.parentId === held.candidate.parentId)
        this.held.delete(key);
    }
    return this.saved(json(res));
  }

  private async reconnect(nodeId: string, signal: AbortSignal | null): Promise<Response> {
    const node = await this.chat.getOwnedNode(nodeId);
    const { sink, response } = this.sseSink(node.id, signal);
    if (this.hub.attach(node.id, sink)) return response;

    // Not running: replay the stored final state.
    // Still `streaming` means an orphan; only it is recovered (other branches may be live).
    const final = (await this.chat.recoverInterruptedNode(node.id)) ?? node;
    const branch = await this.repos.trees.getBranch(final.branchId);
    const text = replayEvents(final, branch).map(sseFrame).join('');
    return sseResponse(
      new ReadableStream({
        start(c) {
          c.enqueue(encoder.encode(text));
          c.close();
        },
      }),
    );
  }

  /**
   * A response streaming the generation of `nodeId` to one reader, and the
   * hub's reader that writes it. Aborting `signal` errors the stream, like fetch.
   */
  private sseSink(
    nodeId: string,
    signal: AbortSignal | null,
  ): { sink: GenerationSink; response: Response } {
    const hub = this.hub;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const sink: GenerationSink = {
      write: (event) => controller.enqueue(encoder.encode(sseFrame(event))),
      close: () => controller.close(),
    };
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        hub.detach(nodeId, sink);
      },
    });
    signal?.addEventListener(
      'abort',
      () => {
        if (hub.detach(nodeId, sink)) controller.error(abortError());
      },
      { once: true },
    );
    return { sink, response: sseResponse(body) };
  }

  private async deleteBranch(branchId: string) {
    const deleted = this.lock.then(() =>
      this.chat.deleteBranch(branchId, {
        stopGenerations: (branchIds) => this.hub.stop((node) => branchIds.has(node.branchId)),
      }),
    );
    this.lock = deleted.catch(() => undefined);
    return deleted;
  }

  // ------------------------------------------------------------- billing

  /** Only Learn spends credit; power accounts use their own keys and are never metered. */
  private outOfCredit(): boolean {
    return this.mode === 'simple' && this.balanceMicros - this.heldMicros <= 0;
  }

  /** Meters every provider call like the Worker's usage meter: hold, then settle at the default fee and markup. */
  private async *meter(
    inner: LlmProvider,
    request: GenerateRequest,
  ): AsyncGenerator<ProviderEvent> {
    const entry: UsageEntry = {
      id: newId(),
      createdAt: this.clock().toISOString(),
      purpose: request.usageTag?.purpose ?? 'other',
      model: request.model,
      treeId: request.usageTag?.treeId ?? null,
      status: 'pending',
      chargeMicros: null,
      inputTokens: null,
      outputTokens: null,
      webSearches: 0,
    };
    this.usage.unshift(entry);
    this.heldMicros += HOLD_MICROS;
    let costUsd: number | null = null;
    try {
      for await (const event of inner.stream(request)) {
        if (event.type === 'usage') {
          entry.inputTokens = event.usage.inputTokens ?? entry.inputTokens;
          entry.outputTokens = event.usage.outputTokens ?? entry.outputTokens;
        } else if (event.type === 'billing') {
          if (event.costUsd !== undefined) costUsd = event.costUsd;
          if (event.webSearches !== undefined) entry.webSearches = event.webSearches;
        }
        yield event;
      }
    } finally {
      this.heldMicros -= HOLD_MICROS;
      if (costUsd === null) {
        entry.status = 'unresolved'; // cancelled or failed: not charged
      } else {
        const charge = chargeMicros(
          costUsdToNanos(costUsd),
          DEFAULT_MARKUP_BPS,
          DEFAULT_OPENROUTER_FEE_BPS,
        );
        entry.status = 'settled';
        entry.chargeMicros = charge;
        this.balanceMicros -= charge;
      }
    }
  }

  private billingSummary(): BillingSummary {
    return {
      enabled: true,
      membership: { ...DEMO_MEMBERSHIP },
      builtInCredit: true,
      topUpsEnabled: false,
      currency: 'usd',
      balanceMicros: this.balanceMicros,
      heldMicros: this.heldMicros,
      availableMicros: this.balanceMicros - this.heldMicros,
      markupBps: DEFAULT_MARKUP_BPS,
      openRouterFeeBps: DEFAULT_OPENROUTER_FEE_BPS,
      lastPurchase: null,
      minTopUpCents: MIN_TOP_UP_CENTS,
      maxTopUpCents: MAX_TOP_UP_CENTS,
    };
  }

  private usagePage(url: URL): UsageListResponse {
    const offset = Math.max(0, Number.parseInt(url.searchParams.get('cursor') ?? '0', 10) || 0);
    const limit = Math.min(
      100,
      Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '50', 10) || 50),
    );
    const entries = this.usage.slice(offset, offset + limit).map((e) => ({ ...e }));
    const next = offset + limit;
    return { entries, nextCursor: next < this.usage.length ? String(next) : null };
  }

  // --------------------------------------------------------- persistence

  private saved(res: Response): Response {
    this.save();
    return res;
  }

  /** Mirrors the session to storage (best effort: a full or blocked storage just stops mirroring). */
  private save(): void {
    if (!this.storage) return;
    const saved: Saved = {
      version: SAVED_VERSION,
      trees: [...this.state.trees.values()],
      branches: [...this.state.branches.values()],
      nodes: [...this.state.nodes.values()],
      links: [...this.state.links.values()],
      summaries: [...this.state.summaries.values()],
      balanceMicros: this.balanceMicros,
      usage: this.usage,
      systemPrompt: this.state.settings.get(DEMO_ACCOUNT_ID)?.systemPrompt ?? null,
    };
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(saved));
    } catch {
      // Quota or privacy settings: the session stays in memory only.
    }
  }

  /** Loads a mirrored session; replies that were generating when the tab reloaded become errors. */
  private restore(): boolean {
    let saved: Saved;
    try {
      const raw = this.storage?.getItem(this.storageKey);
      if (!raw) return false;
      saved = JSON.parse(raw) as Saved;
      if (saved?.version !== SAVED_VERSION || !Array.isArray(saved.trees)) return false;
    } catch {
      return false;
    }
    for (const t of saved.trees) this.state.trees.set(t.id, t);
    for (const b of saved.branches) this.state.branches.set(b.id, b);
    for (const n of saved.nodes) {
      this.state.nodes.set(
        n.id,
        n.status === 'streaming'
          ? { ...n, status: 'error', error: REPLY_INTERRUPTED_ERROR, errorKind: 'interrupted' }
          : // A session saved before nodes had a kind: read it from the message.
            { ...n, errorKind: errorKindOf(n) },
      );
    }
    for (const l of saved.links) this.state.links.set(l.id, l);
    for (const s of saved.summaries) {
      this.state.summaries.set(`${s.anchorNodeId}|${s.sourceHash}|${s.model}`, s);
    }
    if (saved.systemPrompt !== null) {
      this.state.settings.set(DEMO_ACCOUNT_ID, { systemPrompt: saved.systemPrompt });
    }
    this.balanceMicros = saved.balanceMicros;
    this.usage = saved.usage.map((e) =>
      e.status === 'pending' ? { ...e, status: 'unresolved' } : e,
    );
    return true;
  }
}

function providerInfo(provider: LlmProvider): ProviderInfo {
  return {
    id: provider.id,
    kind: provider.kind,
    label: provider.label,
    models: provider.models(),
    defaultModel: provider.defaultModel(),
    openModels: false,
    available: true,
    acceptsUserKey: false,
    keySource: 'server',
    webSearch: provider.capabilities(provider.defaultModel()).supportsWebSearch,
  };
}

/**
 * Sets `usageFactor` on the Max model from the pretend prices (as the Worker
 * does from list prices), so the demo shows the same usage note.
 */
function withUsageFactor(info: ProviderInfo): ProviderInfo {
  const normal = info.models.find((m) => m.tier === 'normal');
  const normalPrice = normal ? DEMO_MODEL_PRICES[normal.id] : undefined;
  return {
    ...info,
    models: info.models.map((m) => {
      if (m.tier !== 'max') return m;
      const maxPrice = DEMO_MODEL_PRICES[m.id];
      const factor = normalPrice && maxPrice ? usageFactorOf(normalPrice, maxPrice) : null;
      return { ...m, usageFactor: factor ?? MAX_USAGE_FACTOR_FALLBACK };
    }),
  };
}

/** A `fetch` that serves `/api/*` from an in-browser demo backend. */
export function createDemoFetch(options: DemoBackendOptions = {}): typeof fetch {
  return new DemoBackend(options).fetch;
}
