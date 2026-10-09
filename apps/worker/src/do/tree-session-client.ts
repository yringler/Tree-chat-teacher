// The Worker's side of the tree's Durable Object protocol (tree-session.ts):
// one method per internal route, so the routes never build its URLs.
import type { AccountContext, AppEnv } from '../env.js';
import type { SessionCommitBody, SessionHoldBody, SessionSendBody } from './tree-session.js';

/** The account as query parameters, for the internal routes without a body (`accountFromParams` reads them). */
export function accountParams(account: AccountContext): Record<string, string> {
  return {
    accountId: account.id,
    mode: account.mode,
    billingAccountId: account.billingAccountId,
    builtIn: account.builtIn ? '1' : '0',
    operatorKeys: account.operatorKeys ? '1' : '0',
    funding: account.funding,
    ...(account.userId ? { userId: account.userId } : {}),
    // One JSON param: the pool's parameters were resolved by the Worker (pool/params.ts).
    ...(account.pool ? { pool: JSON.stringify(account.pool) } : {}),
  };
}

/**
 * The Durable Object of `treeId` (one per tree). Its answers are passed on
 * as they are: an SSE stream, or JSON (an error's JSON body included).
 */
export function treeSession(env: AppEnv, treeId: string) {
  const stub = env.TREE_SESSION.get(env.TREE_SESSION.idFromName(treeId));
  const call = (path: string, params: Record<string, string>, init?: RequestInit) =>
    stub.fetch(
      `https://tree-session${path}?${new URLSearchParams({ treeId, ...params }).toString()}`,
      init,
    );
  const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
  return {
    send: (branchId: string, body: SessionSendBody) => call('/send', { branchId }, post(body)),
    stream: (nodeId: string, account: AccountContext) =>
      call('/stream', { nodeId, ...accountParams(account) }),
    cancel: (nodeId: string, account: AccountContext) =>
      call('/cancel', { nodeId, ...accountParams(account) }, { method: 'POST' }),
    deleteBranch: (branchId: string, account: AccountContext) =>
      call('/delete-branch', { branchId, ...accountParams(account) }, { method: 'POST' }),
    deleteTree: (account: AccountContext) =>
      call('/delete-tree', accountParams(account), { method: 'POST' }),
    holdCandidate: (body: SessionHoldBody) => call('/hold-candidate', {}, post(body)),
    commitCandidate: (body: SessionCommitBody) => call('/commit-candidate', {}, post(body)),
  };
}
