import type { MemoryState } from '@tangent/core/testing';
import type { Branch, ChatNode, Tree, UsageEntry } from '@tangent/shared';
import { formatTangents } from '@tangent/shared';
import { DEMO_PROVIDER_ID, DEMO_SMART_MODEL } from './lorem';

/*
 * The example lesson the demo starts with: a few turns on the main thread,
 * one side question ("Ask about this" on a quoted phrase) and one followed
 * tangent, so the first screen shows what a lesson looks like. Hand-written
 * in the same playful nonsense the demo's tutor speaks, with the same
 * `<tangents>` block real replies end with.
 */

const QUOTE = 'an agreeable owl hums before it ever sings';
/** The tangent of the first reply that the example lesson follows. */
const TANGENT = 'Why practice works better in the evening';

type Turn = readonly [user: string, assistant: string];

const FIRST_TURN: Turn = [
  'How do kittens learn to whistle?',
  [
    'By copying owls, mostly. A kitten is a careful hamster in disguise, and a hamster learns any tune it hears often enough from a bird it respects.',
    'Whistling, in this view, grows out of three small habits:',
    `- **Listening**: ${QUOTE}.\n- **Copying**: the kitten repeats what the owl does, slightly off-key.\n- **Practising**: every evening, a patient lemon applauds a little louder.`,
    'The off-key part matters: a kitten that copies perfectly never finds its own tune.',
    formatTangents([
      { title: TANGENT, why: 'the applauding lemon is doing more than it seems' },
      { title: 'What owls hear that kittens cannot', why: 'the same tune, one layer down' },
      {
        title: 'The myth of the silent kitten',
        why: 'a common misconception, and where it comes from',
      },
    ]),
  ].join('\n\n'),
];

const SECOND_TURN: Turn = [
  'Maybe the kitten would make up its own tune?',
  [
    'Yes, and that is how **creative kittens** are born. A tune without a teacher is a brave grapefruit: wobbly at first, then surprisingly catchy. Some people call this the curious melon effect.',
    formatTangents([
      { title: 'The curious melon effect', why: 'who named it, and why the name stuck' },
      { title: 'Why wobbly tunes are catchier', why: 'an edge case that explains the rule' },
    ]),
  ].join('\n\n'),
];

const SIDE_QUESTION: Turn = [
  'Why does the owl hum first?',
  [
    'Owls are **courteous** creatures: humming is how an owl checks that the night is listening. A humming owl is a calm panda, more or less, and calm pandas rarely sing off-key.',
    formatTangents([
      { title: 'How an owl knows the night is listening', why: 'the mechanism underneath' },
      { title: 'Pandas that sing off-key anyway', why: 'where the simple picture breaks' },
    ]),
  ].join('\n\n'),
];

const TANGENT_TURN: Turn = [
  TANGENT,
  [
    'Because the lemon is louder in the evening, and a louder lemon is a clearer signal. Practice works when the reward arrives right after the attempt, and an evening lemon has had all day to warm up.',
    formatTangents([
      { title: 'Why rewards must arrive quickly', why: 'the timing is the whole trick' },
      { title: 'Morning lemons', why: 'the exception that proves the rule' },
    ]),
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

  const tangent: Branch = {
    ...branchBase,
    id: newId(),
    parentBranchId: trunk.id,
    branchPointNodeId: firstReply.id,
    anchorQuote: null,
    title: TANGENT,
    titleSource: 'user',
    createdAt: at(),
  };
  tangent.updatedAt = tangent.createdAt;
  append(tangent, firstReply.id, 0, TANGENT_TURN);

  tree.updatedAt = nodes.at(-1)?.createdAt ?? created;
  state.trees.set(tree.id, tree);
  for (const b of [trunk, side, tangent]) state.branches.set(b.id, b);
  for (const n of nodes) state.nodes.set(n.id, n);
  return usage;
}
