import type { TreeBackup, TreeDetail } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { ChatService, DEFAULT_CHAT_SETTINGS } from '../../src/services/chat-service.js';
import { ANCHOR_HEADING } from '../../src/context/render.js';
import { createMemoryRepositories } from '../../src/memory/memory-repositories.js';
import { registryOf, ScriptedProvider, send } from './helpers.js';

/** Learn's one provider: the built-in endpoint with Normal and Max. */
class LearnProvider extends ScriptedProvider {
  constructor() {
    super('openrouter');
  }
  override models() {
    return [
      { id: 'normal', label: 'Normal' },
      { id: 'max', label: 'Max' },
    ];
  }
  override defaultModel() {
    return 'normal';
  }
}

/**
 * A power service (own keys: `ant` and `openrouter`; credit) and a Learn
 * service (its one provider, profile `learn`) over the
 * same storage, as the power (`p_`) and Learn (`u_`) accounts of one user.
 */
function setup() {
  const repos = createMemoryRepositories();
  const ant = new ScriptedProvider('ant');
  const own = new LearnProvider();
  const credit = new LearnProvider();
  const learnProvider = new LearnProvider();
  let n = 0;
  const newId = () => `id${++n}`;
  const settings = { ...DEFAULT_CHAT_SETTINGS, autoTitle: false };
  const power = new ChatService({
    repos,
    accountId: 'p_user',
    providers: registryOf(ant, own),
    profile: { kind: 'power', credit: { providers: registryOf(credit) } },
    settings,
    defaultSystemPrompt: 'BUILT-IN',
    newId,
  });
  const learn = new ChatService({
    repos,
    accountId: 'u_user',
    providers: registryOf(learnProvider),
    profile: { kind: 'learn' },
    settings,
    defaultSystemPrompt: 'TUTOR',
    newId,
  });
  return { power, learn, learnProvider, credit, ant };
}

/** A power tree: a trunk on `ant` with a custom prompt, a summary branch on credit, an independent one on an open model. */
async function powerTree(power: ChatService): Promise<TreeDetail> {
  const { tree } = await power.createTree({ providerId: 'ant', systemPrompt: 'Be a pirate.' });
  const { begin } = await send(power, tree.trunkBranchId, 'What is a prime?');
  const from = begin.assistantNode.id;
  await power.createBranch({
    fromNodeId: from,
    providerId: 'openrouter',
    funding: 'credit',
    model: 'max',
    contextMode: 'summary',
    title: 'On credit',
  });
  await power.createBranch({
    fromNodeId: from,
    providerId: 'openrouter',
    model: 'normal',
    contextMode: 'independent',
    anchorQuote: 'two divisors',
    title: 'Independent',
  });
  return power.getTreeDetail(tree.id);
}

const routes = (d: Pick<TreeDetail, 'branches'>) =>
  d.branches.map((b) => [b.title, b.providerId, b.model, b.contextMode, b.funding]);

describe('importing into Learn (profile learn)', () => {
  it('adapts a power backup to Learn: its provider and models, path context, its prompt, own-key', async () => {
    const { power, learn } = setup();
    const original = await powerTree(power);
    const backup = await power.exportBackup(original.tree.id);

    const lesson = await learn.importBackup(backup);
    expect(lesson.tree).toMatchObject({ accountId: 'u_user', systemPrompt: 'TUTOR' });
    expect(routes(lesson)).toEqual([
      ['Main thread', 'openrouter', 'normal', 'path', 'own-key'],
      ['On credit', 'openrouter', 'max', 'path', 'own-key'],
      ['Independent', 'openrouter', 'normal', 'path', 'own-key'],
    ]);
    // Messages, anchors and the provider each reply ran on are kept.
    expect(lesson.nodes.map((n) => [n.content, n.providerId])).toEqual(
      original.nodes.map((n) => [n.content, n.providerId]),
    );
    expect(lesson.branches.find((b) => b.title === 'Independent')?.anchorQuote).toBe(
      'two divisors',
    );
    expect((await learn.listTrees()).map((t) => t.id)).toEqual([lesson.tree.id]);
    expect((await power.listTrees()).map((t) => t.id)).toEqual([original.tree.id]);
  });

  it("uses the Learn account's saved prompt when it has one, like a new lesson", async () => {
    const { power, learn } = setup();
    await learn.updateSettings({ systemPrompt: 'SAVED' });
    const backup = await power.exportBackup((await powerTree(power)).tree.id);
    expect((await learn.importBackup(backup)).tree.systemPrompt).toBe('SAVED');
  });

  it('continues the lesson on the Learn provider with the whole path as context', async () => {
    const { power, learn, learnProvider, ant, credit } = setup();
    const backup = await power.exportBackup((await powerTree(power)).tree.id);
    const lesson = await learn.importBackup(backup);
    const side = lesson.branches.find((b) => b.title === 'Independent')!;
    const before = ant.calls.length;

    const { last } = await send(learn, side.id, 'Why two?');
    expect(last).toMatchObject({
      type: 'done',
      node: { providerId: 'openrouter', model: 'normal' },
    });
    const call = learnProvider.chatCalls().at(-1)!;
    expect(call.model).toBe('normal');
    expect(call.system).toContain('TUTOR');
    // Path context: the trunk's exchange comes before the side question.
    expect(call.messages.map((m) => m.content)).toEqual([
      'What is a prime?',
      'reply to: What is a prime?',
      `${ANCHOR_HEADING}\n\n<excerpt>\ntwo divisors\n</excerpt>\n\nWhy two?`,
    ]);
    expect(ant.calls).toHaveLength(before);
    expect(credit.calls).toHaveLength(0);
  });

  it('leaves power imports as they were', async () => {
    const { power } = setup();
    const original = await powerTree(power);
    const copy = await power.importBackup(await power.exportBackup(original.tree.id));
    expect(copy.tree).toMatchObject({ accountId: 'p_user', systemPrompt: 'Be a pirate.' });
    expect(routes(copy)).toEqual(routes(original));
    expect(routes(copy)).toEqual([
      ['Main thread', 'ant', 'm1', 'path', 'own-key'],
      ['On credit', 'openrouter', 'max', 'summary', 'credit'],
      ['Independent', 'openrouter', 'normal', 'independent', 'own-key'],
    ]);
  });

  it('round-trips: Learn → Learn keeps everything; Learn → power keeps what Learn wrote', async () => {
    const { power, learn } = setup();
    const { tree } = await learn.createTree({ model: 'max' });
    const { begin } = await send(learn, tree.trunkBranchId, 'Teach me primes');
    await learn.createBranch({
      fromNodeId: begin.assistantNode.id,
      contextMode: 'path',
      anchorQuote: 'primes',
      title: 'Side',
    });
    const original = await learn.getTreeDetail(tree.id);
    const backup: TreeBackup = await learn.exportBackup(tree.id);
    // The file is plain JSON, as downloaded and read back.
    const file = JSON.parse(JSON.stringify(backup)) as TreeBackup;

    const again = await learn.importBackup(file);
    const shape = (d: TreeDetail) => ({
      prompt: d.tree.systemPrompt,
      title: d.tree.title,
      routes: routes(d),
      anchors: d.branches.map((b) => b.anchorQuote),
      nodes: d.nodes.map((n) => [n.role, n.content, n.status, n.providerId, n.model]),
    });
    expect(shape(again)).toEqual(shape(original));
    expect(again.tree.id).not.toBe(tree.id);

    const inPower = await power.importBackup(file);
    expect(shape(inPower)).toEqual(shape(original));
    expect(inPower.tree.accountId).toBe('p_user');
  });
});
