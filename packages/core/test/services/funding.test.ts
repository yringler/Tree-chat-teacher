import type { DefaultRouteFacts, ProviderRegistry, TreeBackupInput } from '@tangent/shared';
import { describe, expect, it, vi } from 'vitest';
import { ChatService, DEFAULT_CHAT_SETTINGS } from '../../src/services/chat-service.js';
import { createMemoryRepositories } from '../../src/memory/memory-repositories.js';
import { registryOf, ScriptedProvider, send } from './helpers.js';

/**
 * A branch's provider id names the endpoint; its funding says who pays
 * (`own-key` or Tangent `credit`). Power resolves `credit` routes in a
 * registry of their own; Learn (profile `learn`) resolves every route in its
 * one registry and writes `own-key`.
 */
function setup(options: { credit?: boolean; learn?: boolean } = {}) {
  const own = new ScriptedProvider('openrouter');
  const ant = new ScriptedProvider('ant');
  const credit = new ScriptedProvider('openrouter');
  let n = 0;
  const chat = new ChatService({
    repos: createMemoryRepositories(),
    providers: registryOf(own, ant),
    profile: options.learn
      ? { kind: 'learn' }
      : {
          kind: 'power',
          ...(options.credit === false ? {} : { credit: { providers: registryOf(credit) } }),
        },
    settings: { ...DEFAULT_CHAT_SETTINGS, autoTitle: false },
    newId: () => `id${++n}`,
  });
  return { chat, own, ant, credit };
}

/** `r` with every provider unavailable (no key). */
const unavailable = (r: ProviderRegistry): ProviderRegistry => ({
  ...r,
  list: () => r.list().map((p) => ({ ...p, available: false })),
});

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

  it('refuses the `tangent` id as an unknown provider', async () => {
    const { chat } = setup();
    await expect(chat.createTree({ providerId: 'tangent' })).rejects.toThrow(
      /Unknown provider "tangent"/,
    );
  });

  it('refuses a credit route where credit is not offered, before anything is written', async () => {
    const { chat } = setup({ credit: false });
    await expect(chat.createTree({ providerId: 'openrouter', funding: 'credit' })).rejects.toThrow(
      /on Tangent credit/,
    );
    await expect(chat.createTree({ funding: 'credit' })).rejects.toThrow(/on Tangent credit/);
    expect(await chat.listTrees()).toEqual([]);
  });

  it('defaults a new tree to the first usable own provider, else Tangent credit that can pay', async () => {
    const { chat } = setup();
    expect((await chat.createTree({})).branches[0]).toMatchObject({
      providerId: 'openrouter',
      funding: 'own-key',
    });
    const facts = vi.fn(async () => ({
      creditCanPay: true,
      creditBuyable: false,
      ownKeyLocked: false,
    }));
    const noKeys = new ChatService({
      repos: createMemoryRepositories(),
      providers: unavailable(registryOf(new ScriptedProvider('ant'))),
      profile: {
        kind: 'power',
        credit: {
          providers: registryOf(new ScriptedProvider('openrouter')),
          defaultRouteFacts: facts,
        },
      },
      settings: DEFAULT_CHAT_SETTINGS,
    });
    expect((await noKeys.createTree({})).branches[0]).toMatchObject({
      providerId: 'openrouter',
      funding: 'credit',
    });
    expect(facts).toHaveBeenCalledTimes(1);
    expect((await noKeys.createTree({ funding: 'credit' })).branches[0]).toMatchObject({
      providerId: 'openrouter',
      funding: 'credit',
    });
    // A named route needs no facts.
    await noKeys.createTree({ providerId: 'ant' });
    expect(facts).toHaveBeenCalledTimes(1);
  });

  it("never defaults onto credit that can't pay: OpenRouter on the own key, else the first configured", async () => {
    const chatWith = (own: ScriptedProvider[], facts?: DefaultRouteFacts) =>
      new ChatService({
        repos: createMemoryRepositories(),
        providers: unavailable(registryOf(...own)),
        profile: {
          kind: 'power',
          credit: {
            providers: registryOf(new ScriptedProvider('openrouter')),
            ...(facts ? { defaultRouteFacts: async () => facts } : {}),
          },
        },
        settings: DEFAULT_CHAT_SETTINGS,
      });
    const zero = { creditCanPay: false, creditBuyable: false, ownKeyLocked: false };
    const ant = () => new ScriptedProvider('ant');
    const openrouter = () => new ScriptedProvider('openrouter');
    // Zero balance (or nothing known about it): the user's own OpenRouter, asked for on the first send.
    for (const facts of [zero, undefined])
      expect(
        (await chatWith([ant(), openrouter()], facts).createTree({})).branches[0],
      ).toMatchObject({ providerId: 'openrouter', funding: 'own-key' });
    // No OpenRouter configured: the first configured own provider.
    expect((await chatWith([ant()], zero).createTree({})).branches[0]).toMatchObject({
      providerId: 'ant',
      funding: 'own-key',
    });
    // Own keys need a membership the user lacks, and credit can pay: credit, even over a key.
    const locked = new ChatService({
      repos: createMemoryRepositories(),
      providers: registryOf(ant()),
      profile: {
        kind: 'power',
        credit: {
          providers: registryOf(openrouter()),
          defaultRouteFacts: async () => ({
            creditCanPay: true,
            creditBuyable: false,
            ownKeyLocked: true,
          }),
        },
      },
      settings: DEFAULT_CHAT_SETTINGS,
    });
    expect((await locked.createTree({})).branches[0]).toMatchObject({
      providerId: 'openrouter',
      funding: 'credit',
    });
    // Naming the own key leaves credit out.
    expect((await locked.createTree({ funding: 'own-key' })).branches[0]).toMatchObject({
      providerId: 'ant',
      funding: 'own-key',
    });
  });

  it('with nothing usable on either registry, a new tree starts on an own provider, on the own key', async () => {
    const chat = new ChatService({
      repos: createMemoryRepositories(),
      providers: unavailable(registryOf(new ScriptedProvider('ant'), new ScriptedProvider('oai'))),
      profile: {
        kind: 'power',
        credit: {
          providers: unavailable(registryOf(new ScriptedProvider('openrouter'))),
          defaultRouteFacts: async () => ({
            creditCanPay: true,
            creditBuyable: false,
            ownKeyLocked: false,
          }),
        },
      },
      settings: DEFAULT_CHAT_SETTINGS,
    });
    // Sending then asks for the key (the Worker's gate); credit is never picked implicitly.
    expect((await chat.createTree({})).branches[0]).toMatchObject({
      providerId: 'ant',
      funding: 'own-key',
    });
    // Naming only the own key: the same rule over the own providers.
    expect((await chat.createTree({ funding: 'own-key' })).branches[0]).toMatchObject({
      providerId: 'ant',
      funding: 'own-key',
    });
  });

  it('Learn starts a new tree on its one provider, own-key', async () => {
    const learn = new ChatService({
      repos: createMemoryRepositories(),
      providers: unavailable(registryOf(new ScriptedProvider('openrouter'))),
      profile: { kind: 'learn' },
      settings: DEFAULT_CHAT_SETTINGS,
    });
    expect((await learn.createTree({})).branches[0]).toMatchObject({
      providerId: 'openrouter',
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
    const { chat, own, credit } = setup({ learn: true });
    const { tree } = await chat.createTree({ providerId: 'openrouter', funding: 'credit' });
    const trunk = await chat.getOwnedBranch(tree.trunkBranchId);
    expect(trunk).toMatchObject({ providerId: 'openrouter', funding: 'own-key' });
    await send(chat, trunk.id, 'learn');
    expect(own.chatCalls()).toHaveLength(1);
    expect(credit.calls).toHaveLength(0);
    expect((await chat.planContext(trunk.id, null, { resolveSummaries: false })).funding).toBe(
      'own-key',
    );
  });

  it('import reads a missing funding as own-key', async () => {
    const { chat } = setup();
    const at = '2026-01-01T00:00:00.000Z';
    const backup: TreeBackupInput = {
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
        // No funding.
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
          providerId: 'openrouter',
          model: 'm1',
          createdAt: at,
          updatedAt: at,
        },
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
          providerId: 'openrouter',
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

    const learn = setup({ learn: true });
    const learned = await learn.chat.importBackup(backup);
    expect(learned.branches.map((b) => b.funding)).toEqual(['own-key', 'own-key']);
  });
});
