/*
 * Seeds the power demo with a heavy branching conversation, built in Node by
 * the demo's own in-browser backend (the real ChatService over in-memory
 * repositories, the lorem provider with no delay between words). The result
 * is the demo's sessionStorage mirror (`tangent.power-demo.v1`), which the
 * page restores on load (packages/web-shared/src/demo/backend.ts `restore`).
 *
 * Shape: a trunk of `trunkExchanges` exchanges; from its last reply,
 * `fanout` branches; in each, 1–2 exchanges, then `fanout` branches from its
 * last reply; down to `depth`. The "spine" (always the first child) stays in
 * `path` mode, so its leaf is the heaviest context; other branches mix in
 * `summary`, `message` and `independent`. The spine's leaf gets
 * `leafExchanges` exchanges, to have a long branch to scroll.
 */
import type {
  Branch,
  ContextMode,
  StreamEvent,
  TreeDetail,
} from '../../../packages/shared/src/index.js';
import { DemoBackend, type DemoStorage } from '../../../packages/web-shared/src/demo/backend.js';
import { createLoremProvider, seededRandom } from '../../../packages/web-shared/src/demo/lorem.js';

export const DEMO_STORAGE_KEY = 'tangent.power-demo.v1';

export interface SeedOptions {
  depth: number;
  fanout: number;
  trunkExchanges?: number;
  leafExchanges?: number;
  seed?: number;
}

export interface SeededBranch {
  id: string;
  title: string;
  depth: number;
  mode: ContextMode;
  /** Child indexes from the trunk, e.g. [0, 1, 0]. */
  route: number[];
  messages: number;
  /** Messages the chat view shows for this branch (ancestors + its own). */
  pathLength: number;
}

export interface SeededTree {
  /** The JSON the demo restores from sessionStorage. */
  saved: string;
  treeId: string;
  trunkId: string;
  branches: SeededBranch[];
  /** The deepest branch on the spine (all first children, all `path`). */
  spineLeafId: string;
  /** A depth-1 branch on the spine. */
  shallowId: string;
  nodeCount: number;
  trunkPathLength: number;
}

class MemoryStorage implements DemoStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** Sends a message and reads its stream to the end; returns the reply node's id. */
async function send(backend: DemoBackend, branchId: string, content: string): Promise<string> {
  const res = await backend.fetch(`/api/branches/${branchId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
  if (!res.ok || !res.body) throw new Error(`send failed: ${res.status} ${await res.text()}`);
  const text = await res.text();
  let replyId: string | null = null;
  for (const frame of text.split('\n\n')) {
    const data = frame.split('\n').find((l) => l.startsWith('data: '));
    if (!data) continue;
    const event = JSON.parse(data.slice(6)) as StreamEvent;
    if (event.type === 'done') replyId = event.node.id;
    if (event.type === 'error') throw new Error(`generation failed: ${event.message}`);
  }
  if (!replyId) throw new Error('no done event');
  return replyId;
}

function modeFor(spine: boolean, n: number): ContextMode {
  if (spine) return 'path';
  // Mostly path; some summary / message / independent.
  const r = n % 10;
  if (r === 3 || r === 7) return 'summary';
  if (r === 5) return 'message';
  if (r === 9) return 'independent';
  return 'path';
}

const QUESTIONS = [
  'Can you explain that in more detail?',
  'How does this relate to what we said before?',
  'Give me a concrete example of that, please.',
  'What are the main trade-offs here?',
  'Why does that work the way it does?',
];

export async function seedHeavyTree(options: SeedOptions): Promise<SeededTree> {
  const { depth, fanout } = options;
  const trunkExchanges = options.trunkExchanges ?? 3;
  const leafExchanges = options.leafExchanges ?? 10;
  const random = seededRandom(options.seed ?? 42);
  const storage = new MemoryStorage();
  const backend = new DemoBackend({
    mode: 'power',
    // No pauses: neither between words nor for the pretend web search (400 ms).
    provider: createLoremProvider({ random, sleep: () => Promise.resolve() }),
    storage,
  });

  const detail = await readJson<TreeDetail>(
    await backend.fetch('/api/trees', { method: 'POST', body: JSON.stringify({}) }),
  );
  const treeId = detail.tree.id;
  const trunkId = detail.tree.trunkBranchId;
  // Grounding off for the whole tree (branches inherit it): with `auto`, the lorem
  // provider pretends to search the web on most replies, a random 400 ms before the
  // first word, which would swamp time-to-first-token differences.
  await readJson<Branch>(
    await backend.fetch(`/api/branches/${trunkId}`, {
      method: 'PATCH',
      body: JSON.stringify({ grounding: 'off' }),
    }),
  );
  let q = 0;
  const question = (): string => QUESTIONS[q++ % QUESTIONS.length]!;

  let last = '';
  for (let i = 0; i < trunkExchanges; i++) last = await send(backend, trunkId, question());

  const branches: SeededBranch[] = [];
  let counter = 0;
  let spineLeafId = '';
  let shallowId = '';

  const grow = async (
    parentReplyId: string,
    level: number,
    route: number[],
    spine: boolean,
  ): Promise<void> => {
    if (level > depth) return;
    for (let c = 0; c < fanout; c++) {
      const onSpine = spine && c === 0;
      const mode = modeFor(onSpine, counter++);
      const childRoute = [...route, c];
      const title = `D${level} ${childRoute.join('.')}`;
      const branch = await readJson<Branch>(
        await backend.fetch('/api/branches', {
          method: 'POST',
          body: JSON.stringify({ fromNodeId: parentReplyId, contextMode: mode, title }),
        }),
      );
      const exchanges = onSpine && level === depth ? leafExchanges : 1 + (counter % 2);
      let reply = '';
      for (let i = 0; i < exchanges; i++) reply = await send(backend, branch.id, question());
      branches.push({
        id: branch.id,
        title,
        depth: level,
        mode,
        route: childRoute,
        messages: exchanges * 2,
        pathLength: 0,
      });
      if (onSpine && level === 1) shallowId = branch.id;
      if (onSpine && level === depth) spineLeafId = branch.id;
      await grow(reply, level + 1, childRoute, onSpine);
    }
  };
  await grow(last, 1, [], true);

  const saved = storage.getItem(DEMO_STORAGE_KEY);
  if (!saved) throw new Error('the demo backend saved nothing');
  const { nodes, branches: all } = JSON.parse(saved) as {
    nodes: { id: string; treeId: string; branchId: string; parentId: string | null }[];
    branches: { id: string; branchPointNodeId: string | null }[];
  };
  const mine = nodes.filter((n) => n.treeId === treeId);
  const byId = new Map(mine.map((n) => [n.id, n]));
  const pathLength = (branchId: string): number => {
    const point = all.find((b) => b.id === branchId)?.branchPointNodeId ?? null;
    let ancestors = 0;
    for (
      let n = point ? byId.get(point) : undefined;
      n;
      n = n.parentId ? byId.get(n.parentId) : undefined
    )
      ancestors++;
    return ancestors + mine.filter((n) => n.branchId === branchId).length;
  };
  for (const b of branches) b.pathLength = pathLength(b.id);
  return {
    saved,
    treeId,
    trunkId,
    branches,
    spineLeafId,
    shallowId,
    nodeCount: mine.length,
    trunkPathLength: pathLength(trunkId),
  };
}
