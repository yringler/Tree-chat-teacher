import type { MemoryState } from '@tangent/core/testing';
import type { Branch, ChatNode, Tree, UsageEntry } from '@tangent/shared';
import { DEMO_PROVIDER_ID, DEMO_SMART_MODEL } from './lorem';

/*
 * The example lesson the demo starts with: a few turns on the main thread
 * and one side question ("Ask about this" on a quoted phrase), so the first
 * screen shows what a lesson looks like. Hand-written in the same playful
 * nonsense the demo's tutor speaks.
 */

const QUOTE = 'an agreeable owl hums before it ever sings';

type Turn = readonly [user: string, assistant: string];

const FIRST_TURN: Turn = [
  'How do kittens learn to whistle?',
  [
    "Good question! Let's start with **a confident kitten** standing next to a pineapple. The kitten is a careful hamster in disguise, and the pineapple is just a bright strawberry with better manners.",
    'Whistling, in this view, grows out of three small habits:',
    `- **Listening**: ${QUOTE}.\n- **Copying**: the kitten repeats what the owl does, slightly off-key.\n- **Practising**: every evening, a patient lemon applauds a little louder.`,
    'What do you think would happen if the owl stopped humming?',
  ].join('\n\n'),
];

const SECOND_TURN: Turn = [
  'Maybe the kitten would make up its own tune?',
  [
    'Exactly, and that is how **creative kittens** are born! A tune without a teacher is a brave grapefruit: wobbly at first, then surprisingly catchy. Some people call this the curious melon effect.',
    'Can you give an example of something you learned without a teacher?',
  ].join('\n\n'),
];

const SIDE_QUESTION: Turn = [
  'Why does the owl hum first?',
  [
    'Owls are **courteous** creatures: humming is how an owl checks that the night is listening. A humming owl is a calm panda, more or less, and calm pandas rarely sing off-key.',
    'Why might humming come before singing?',
  ].join('\n\n'),
];

export interface SeedOptions {
  accountId: string;
  now: Date;
  newId: () => string;
}

/** Writes the example lesson into `state`; returns the usage entries of its (pretend) replies, newest first. */
export function seedDemoLesson(
  state: MemoryState,
  { accountId, now, newId }: SeedOptions,
): UsageEntry[] {
  let minutes = 30;
  const at = (): string => new Date(now.getTime() - minutes-- * 60_000).toISOString();

  const created = at();
  const tree: Tree = {
    id: newId(),
    accountId,
    title: 'How do kittens learn to whistle?',
    systemPrompt: null,
    trunkBranchId: newId(),
    createdAt: created,
    updatedAt: created,
  };
  const branchBase = {
    treeId: tree.id,
    contextMode: 'path' as const,
    isPrivate: false,
    providerId: DEMO_PROVIDER_ID,
    model: DEMO_SMART_MODEL,
    createdAt: created,
    updatedAt: created,
  };
  const trunk: Branch = {
    ...branchBase,
    id: tree.trunkBranchId,
    parentBranchId: null,
    branchPointNodeId: null,
    anchorQuote: null,
    title: 'Main thread',
    titleSource: 'default',
  };

  const nodes: ChatNode[] = [];
  const usage: UsageEntry[] = [];
  const append = (branch: Branch, parentId: string | null, seq: number, [q, a]: Turn): ChatNode => {
    const base = { treeId: tree.id, branchId: branch.id, status: 'complete' as const, error: null };
    const user: ChatNode = {
      ...base,
      id: newId(),
      parentId,
      seq,
      role: 'user',
      content: q,
      providerId: null,
      model: null,
      usage: null,
      createdAt: at(),
    };
    const inputTokens = 420 + seq * 160;
    const outputTokens = Math.ceil(a.length / 4);
    const reply: ChatNode = {
      ...base,
      id: newId(),
      parentId: user.id,
      seq: seq + 1,
      role: 'assistant',
      content: a,
      providerId: branch.providerId,
      model: branch.model,
      usage: { inputTokens, outputTokens },
      createdAt: at(),
    };
    nodes.push(user, reply);
    const chargeMicros = 2_200 + outputTokens * 28;
    usage.unshift({
      id: newId(),
      createdAt: reply.createdAt,
      purpose: 'reply',
      model: branch.model,
      treeId: tree.id,
      status: 'settled',
      chargeMicros,
      inputTokens,
      outputTokens,
    });
    return reply;
  };

  const firstReply = append(trunk, null, 0, FIRST_TURN);
  append(trunk, firstReply.id, 2, SECOND_TURN);

  const side: Branch = {
    ...branchBase,
    id: newId(),
    parentBranchId: trunk.id,
    branchPointNodeId: firstReply.id,
    anchorQuote: QUOTE,
    title: 'Why the owl hums first',
    titleSource: 'auto',
    createdAt: at(),
  };
  side.updatedAt = side.createdAt;
  append(side, firstReply.id, 0, SIDE_QUESTION);

  tree.updatedAt = nodes.at(-1)?.createdAt ?? created;
  state.trees.set(tree.id, tree);
  for (const b of [trunk, side]) state.branches.set(b.id, b);
  for (const n of nodes) state.nodes.set(n.id, n);
  return usage;
}
