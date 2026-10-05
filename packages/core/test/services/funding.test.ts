import type { TreeBackup } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { ChatService, DEFAULT_CHAT_SETTINGS } from '../../src/services/chat-service.js';
import { createMemoryRepositories } from '../../src/testing/memory-repositories.js';
import { registryOf, ScriptedProvider, send } from './helpers.js';

/**
 * A branch's provider id names the endpoint; its funding says who pays
 * (`own-key` or Tangent `credit`). Power resolves `credit` routes in a
 * registry of their own; Learn (`fixedFunding`) resolves every route in its
 * one registry and writes `own-key`.
 */
function setup(options: { credit?: boolean; fixedFunding?: 'own-key' } = {}) {
  const own = new ScriptedProvider('openrouter');
  const ant = new ScriptedProvider('ant');
  const credit = new ScriptedProvider('openrouter');
  let n = 0;
  const chat = new ChatService({
    repos: createMemoryRepositories(),
    providers: registryOf(own, ant),
    ...(options.credit === false ? {} : { creditProviders: registryOf(credit) }),
    ...(options.fixedFunding ? { fixedFunding: options.fixedFunding } : {}),
    settings: { ...DEFAULT_CHAT_SETTINGS, autoTitle: false },
    newId: () => `id${++n}`,
  });
  return { chat, own, ant, credit };
}

describe('ChatService routes (provider + funding)', () => {
  it('a credit branch calls the credit registry, an own-key branch the own one, under one provider id', async () => {
    const { chat, own, credit } = setup();
    const { tree } = await chat.createTree({ providerId: 'openrouter', funding: 'credit' });
    expect((await chat.getOwnedBranch(tree.trunkBranchId)).funding).toBe('credit');
    await send(chat, tree.trunkBranchId, 'on credit');
    expect(credit.chatCalls()).toHaveLength(1);
    expect(own.calls).toHaveLength(0);

    const mine = await chat.createTree({ providerId: 'openrouter' });
    expect(mine.branches[0]).toMatchObject({ providerId: 'openrouter', funding: 'own-key' });
    const { last } = await send(chat, mine.tree.trunkBranchId, 'on my key');
    expect(last).toMatchObject({ type: 'done', node: { providerId: 'openrouter' } });
    expect(own.chatCalls()).toHaveLength(1);
    expect(credit.chatCalls()).toHaveLength(1);
  });

  it('a branch inherits its parent route; naming a provider alone means own key, a funding alone keeps the provider', async () => {
    const { chat } = setup();
    const { tree } = await chat.createTree({ providerId: 'openrouter', funding: 'credit' });
    const { begin } = await send(chat, tree.trunkBranchId, 'hi');
    const from = begin.assistantNode.id;
    expect(await chat.createBranch({ fromNodeId: from })).toMatchObject({
      providerId: 'openrouter',
      funding: 'credit',
    });
    expect(await chat.createBranch({ fromNodeId: from, providerId: 'ant' })).toMatchObject({
      providerId: 'ant',
      funding: 'own-key',
    });
    expect(await chat.createBranch({ fromNodeId: from, providerId: 'openrouter' })).toMatchObject({
      providerId: 'openrouter',
      funding: 'own-key',
    });
    const own = await chat.createBranch({ fromNodeId: from, funding: 'own-key' });
    expect(own).toMatchObject({ providerId: 'openrouter', funding: 'own-key', model: 'm1' });
    // Switching only the funding keeps the provider and its model.
    expect(await chat.updateBranch(own.id, { funding: 'credit' })).toMatchObject({
      providerId: 'openrouter',
      funding: 'credit',
      model: 'm1',
    });
    // A model change alone keeps the route.
    expect(await chat.updateBranch(own.id, { model: 'm1' })).toMatchObject({ funding: 'credit' });
  });

  it('reads the legacy `tangent` id as the built-in endpoint on credit', async () => {
    const { chat } = setup();
    const { tree } = await chat.createTree({ providerId: 'tangent' });
    expect(await chat.getOwnedBranch(tree.trunkBranchId)).toMatchObject({
      providerId: 'openrouter',
      funding: 'credit',
    });
    const updated = await chat.updateBranch(tree.trunkBranchId, {
      providerId: 'tangent',
      funding: 'own-key',
    });
    expect(updated).toMatchObject({ providerId: 'openrouter', funding: 'own-key' });
  });

  it('refuses a credit route where credit is not offered, before anything is written', async () => {
    const { chat } = setup({ credit: false });
    await expect(chat.createTree({ providerId: 'openrouter', funding: 'credit' })).rejects.toThrow(
      /on Tangent credit/,
    );
    await expect(chat.createTree({ funding: 'credit' })).rejects.toThrow(/on Tangent credit/);
    expect(await chat.listTrees()).toEqual([]);
  });

  it('defaults a new tree to the first usable own provider, else Tangent credit', async () => {
    const { chat } = setup();
    expect((await chat.createTree({})).branches[0]).toMatchObject({
      providerId: 'openrouter',
      funding: 'own-key',
    });
    const noKeys = new ChatService({
      repos: createMemoryRepositories(),
      providers: {
        ...registryOf(new ScriptedProvider('ant')),
        list: () =>
          registryOf(new ScriptedProvider('ant'))
            .list()
            .map((p) => ({ ...p, available: false })),
      },
      creditProviders: registryOf(new ScriptedProvider('openrouter')),
      settings: DEFAULT_CHAT_SETTINGS,
    });
    expect((await noKeys.createTree({})).branches[0]).toMatchObject({
      providerId: 'openrouter',
      funding: 'credit',
    });
    expect((await noKeys.createTree({ funding: 'credit' })).branches[0]).toMatchObject({
      providerId: 'openrouter',
      funding: 'credit',
    });
  });

  it('with nothing usable on either registry, a new tree starts on the own default, on the own key', async () => {
    const unavailable = (r: ReturnType<typeof registryOf>) => ({
      ...r,
      list: () => r.list().map((p) => ({ ...p, available: false })),
    });
    const chat = new ChatService({
      repos: createMemoryRepositories(),
      providers: unavailable(registryOf(new ScriptedProvider('ant'), new ScriptedProvider('oai'))),
      creditProviders: unavailable(registryOf(new ScriptedProvider('openrouter'))),
      settings: DEFAULT_CHAT_SETTINGS,
    });
    // Sending then asks for the key (the Worker's gate); credit is never picked implicitly.
    expect((await chat.createTree({})).branches[0]).toMatchObject({
      providerId: 'ant',
      funding: 'own-key',
    });
    // Naming only the own key: its registry's default, whatever is usable.
    expect((await chat.createTree({ funding: 'own-key' })).branches[0]).toMatchObject({
      providerId: 'ant',
      funding: 'own-key',
    });
  });

  it('moving a branch to another provider takes that provider’s default model unless one is named', async () => {
    const ant = new ScriptedProvider('ant');
    ant.defaultModel = () => 'ant-default';
    ant.models = () => [{ id: 'ant-default', label: 'A' }];
    const chat = new ChatService({
      repos: createMemoryRepositories(),
      providers: registryOf(new ScriptedProvider('openrouter'), ant),
      settings: DEFAULT_CHAT_SETTINGS,
    });
    const { tree } = await chat.createTree({ providerId: 'openrouter' });
    expect(await chat.updateBranch(tree.trunkBranchId, { providerId: 'ant' })).toMatchObject({
      providerId: 'ant',
      model: 'ant-default',
      funding: 'own-key',
    });
  });

  it('a review on credit runs on the credit registry and says so', async () => {
    const { chat, credit, own } = setup();
    const { tree } = await chat.createTree({ providerId: 'openrouter' });
    const { begin } = await send(chat, tree.trunkBranchId, 'hi');
    const prepared = await chat.prepareReview(begin.assistantNode.id, {
      providerId: 'openrouter',
      funding: 'credit',
      model: 'm1',
    });
    const events = [];
    for await (const e of chat.runReview(prepared, new AbortController().signal)) events.push(e);
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      providerId: 'openrouter',
      funding: 'credit',
    });
    expect(credit.chatCalls()).toHaveLength(1);
    expect(own.chatCalls()).toHaveLength(1); // the reply itself
  });

  it('Learn (fixed funding) ignores a branch funding, writes own-key and keeps one registry', async () => {
    const { chat, own, credit } = setup({ fixedFunding: 'own-key' });
    const { tree } = await chat.createTree({ providerId: 'openrouter', funding: 'credit' });
    const trunk = await chat.getOwnedBranch(tree.trunkBranchId);
    expect(trunk).toMatchObject({ providerId: 'openrouter', funding: 'own-key' });
    const legacy = await chat.updateBranch(trunk.id, { providerId: 'tangent' });
    expect(legacy).toMatchObject({ providerId: 'openrouter', funding: 'own-key' });
    await send(chat, trunk.id, 'learn');
    expect(own.chatCalls()).toHaveLength(1);
    expect(credit.calls).toHaveLength(0);
    expect((await chat.planContext(trunk.id, null, { resolveSummaries: false })).funding).toBe(
      'own-key',
    );
  });

  it('import maps legacy `tangent` to openrouter and a missing funding to own-key', async () => {
    const { chat } = setup();
    const at = '2026-01-01T00:00:00.000Z';
    const backup: TreeBackup = {
      format: 'tangent-tree-backup',
      version: 1,
      exportedAt: at,
      tree: {
        id: 't',
        accountId: 'x',
        title: 'Old',
        systemPrompt: null,
        trunkBranchId: 'b',
        createdAt: at,
        updatedAt: at,
      },
      branches: [
        // A pre-split backup: no funding, the legacy id.
        {
          id: 'b',
          treeId: 't',
          parentBranchId: null,
          branchPointNodeId: null,
          contextMode: 'path',
          anchorQuote: null,
          title: 'Main',
          titleSource: 'default',
          isPrivate: false,
          providerId: 'tangent',
          model: 'm1',
          createdAt: at,
          updatedAt: at,
        } as unknown as TreeBackup['branches'][number],
        {
          id: 'c',
          treeId: 't',
          parentBranchId: 'b',
          branchPointNodeId: 'n2',
          contextMode: 'path',
          anchorQuote: null,
          title: 'Side',
          titleSource: 'user',
          isPrivate: false,
          providerId: 'openrouter',
          model: 'm1',
          funding: 'credit',
          createdAt: at,
          updatedAt: at,
        },
      ],
      nodes: [
        {
          id: 'n1',
          treeId: 't',
          branchId: 'b',
          parentId: null,
          seq: 0,
          role: 'user',
          content: 'q',
          status: 'complete',
          error: null,
          providerId: null,
          model: null,
          usage: null,
          createdAt: at,
        },
        {
          id: 'n2',
          treeId: 't',
          branchId: 'b',
          parentId: 'n1',
          seq: 1,
          role: 'assistant',
          content: 'a',
          status: 'complete',
          error: null,
          providerId: 'tangent',
          model: 'm1',
          usage: null,
          createdAt: at,
        },
      ],
    };
    const detail = await chat.importBackup(backup);
    const byTitle = new Map(detail.branches.map((b) => [b.title, b]));
    expect(byTitle.get('Main')).toMatchObject({ providerId: 'openrouter', funding: 'own-key' });
    expect(byTitle.get('Side')).toMatchObject({ providerId: 'openrouter', funding: 'credit' });
    expect(detail.nodes.find((n) => n.role === 'assistant')?.providerId).toBe('openrouter');

    const learn = setup({ fixedFunding: 'own-key' });
    const learned = await learn.chat.importBackup(backup);
    expect(learned.branches.map((b) => b.funding)).toEqual(['own-key', 'own-key']);
  });
});
