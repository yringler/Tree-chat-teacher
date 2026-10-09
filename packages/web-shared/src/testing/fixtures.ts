import type {
  BillingSummary,
  Branch,
  ChatNode,
  MembershipInfo,
  NodeLink,
  ProviderInfo,
  ShareSummary,
  StreamEvent,
  Tree,
  TreeDetail,
} from '@tangent/shared';

/** The timestamp every fixture carries. */
export const T = '2026-01-01T00:00:00.000Z';

/** A branch of tree `t1`: a trunk on the user's own OpenRouter key unless `over` says otherwise. */
export function branch(id: string, over: Partial<Branch> = {}): Branch {
  return {
    id,
    treeId: 't1',
    parentBranchId: null,
    branchPointNodeId: null,
    contextMode: 'path',
    anchorQuote: null,
    title: id,
    titleSource: 'default',
    isPrivate: false,
    providerId: 'openrouter',
    model: 'a/b',
    funding: 'own-key',
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

/** A finished reply on the trunk of tree `t1` unless `over` says otherwise. */
export function node(id: string, over: Partial<ChatNode> = {}): ChatNode {
  return {
    id,
    treeId: 't1',
    branchId: 'trunk',
    parentId: null,
    seq: 0,
    role: 'assistant',
    content: '',
    status: 'complete',
    error: null,
    providerId: null,
    model: null,
    usage: null,
    createdAt: T,
    ...over,
  };
}

/** A link the user made between two messages of tree `t1`. */
export function link(
  id: string,
  sourceNodeId: string,
  targetNodeId: string,
  note: string | null = null,
): NodeLink {
  return {
    id,
    treeId: 't1',
    sourceNodeId,
    targetNodeId,
    note,
    origin: 'user',
    createdAt: T,
    updatedAt: T,
  };
}

/** Tree `t1` ("Light", its trunk `trunk`) with these branches, messages and links. */
export function detail(
  nodes: ChatNode[] = [],
  branches: Branch[] = [branch('trunk')],
  links: NodeLink[] = [],
  tree: Partial<Tree> = {},
): TreeDetail {
  return {
    tree: {
      id: 't1',
      accountId: 'u_1',
      title: 'Light',
      systemPrompt: null,
      learnerInstructions: null,
      trunkBranchId: 'trunk',
      createdAt: T,
      updatedAt: T,
      ...tree,
    },
    branches,
    nodes,
    links,
  };
}

/** A provider entry: OpenRouter on the user's own key, saved, unless `over` says otherwise. */
export function provider(over: Partial<ProviderInfo> = {}): ProviderInfo {
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

/** A required membership the user has, unless `over` says otherwise. */
export function membership(over: Partial<MembershipInfo> = {}): MembershipInfo {
  return {
    required: true,
    status: 'active',
    subscriptionStatus: 'active',
    periodEnd: null,
    cancelAtPeriodEnd: false,
    priceCents: 1000,
    ...over,
  };
}

/** A billing summary with Tangent credit on sale and none left, unless `over` says otherwise. */
export function billing(over: Partial<BillingSummary> = {}): BillingSummary {
  return {
    enabled: true,
    membership: membership({ required: false, status: 'inactive', subscriptionStatus: null }),
    builtInCredit: true,
    currency: 'usd',
    balanceMicros: 0,
    heldMicros: 0,
    availableMicros: 0,
    markupBps: 1000,
    openRouterFeeBps: 550,
    minTopUpCents: 500,
    maxTopUpCents: 50_000,
    ...over,
  };
}

/** An active snapshot share of the whole of tree `t1` ("Primes"). */
export function share(id: string, over: Partial<ShareSummary> = {}): ShareSummary {
  return {
    id,
    token: `tok-${id}`,
    accountId: 'p_1',
    treeId: 't1',
    scope: 'tree',
    targetNodeId: null,
    includeAncestors: false,
    mode: 'snapshot',
    title: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: T,
    updatedAt: T,
    publishedAt: T,
    version: 1,
    viewCount: 0,
    treeTitle: 'Primes',
    url: `https://tangent.example/s/tok-${id}`,
    state: 'active',
    ...over,
  };
}

/** `events` as the server streams them. */
export const sse = (events: StreamEvent[]): string =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

/** A stream response that emits `events` and then closes. */
export function stream(events: StreamEvent[]): Response {
  return new Response(sse(events), { headers: { 'content-type': 'text/event-stream' } });
}

/** A stream response the test drives: `push` more events, then `close`. */
export function controlledStream(first: StreamEvent[]) {
  const enc = new TextEncoder();
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
      c.enqueue(enc.encode(sse(first)));
    },
  });
  return {
    response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    push: (events: StreamEvent[]) => ctrl.enqueue(enc.encode(sse(events))),
    close: () => ctrl.close(),
  };
}

/** A promise settled from outside. */
export function deferred<V>() {
  let resolve!: (value: V) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<V>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
