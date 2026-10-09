import type { GenerateRequest, ProviderEvent } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import {
  ChatService,
  DEFAULT_CHAT_SETTINGS,
  type ChatServiceDeps,
} from '../../src/services/chat-service.js';
import { createMemoryRepositories } from '../../src/memory/memory-repositories.js';
import { estimateTokens } from '../../src/tokens.js';
import { collect, registryOf, ScriptedProvider, send } from './helpers.js';

/** A scripted provider (not `fake`, so titles run) whose title calls can be refused. */
class TitleRefusingProvider extends ScriptedProvider {
  refuseTitles = false;
  override async *stream(req: GenerateRequest): AsyncIterable<ProviderEvent> {
    if (this.refuseTitles && this.kindOf(req) === 'title') {
      this.calls.push(req);
      yield { type: 'error', error: { code: 'rate_limit', message: 'refused', retryable: false } };
      return;
    }
    yield* super.stream(req);
  }
}

function setup(deps: Partial<ChatServiceDeps> = {}) {
  const repos = createMemoryRepositories();
  const provider = new TitleRefusingProvider();
  let n = 0;
  const chat = new ChatService({
    repos,
    providers: registryOf(provider),
    settings: { ...DEFAULT_CHAT_SETTINGS, autoTitle: true },
    newId: () => `id${(++n).toString().padStart(4, '0')}`,
    ...deps,
  });
  return { repos, provider, chat };
}

const PINNED: Partial<ChatServiceDeps> = {
  profile: {
    kind: 'pool',
    model: 'pool-model',
    systemPrompt: 'LOCKED PROMPT',
    estimateTokens,
    anchorQuoteMaxChars: 10_000,
  },
};

describe('ChatService pool profile: pinned model and locked prompt', () => {
  it("replies, summaries and titles use the pinned model and prompt; the tree and branch don't change", async () => {
    const { chat, provider, repos } = setup(PINNED);
    const { tree } = await chat.createTree({ systemPrompt: 'IGNORE ME', model: 'm1' });
    await chat.updateTree(tree.id, { systemPrompt: 'IGNORE ME TOO' });

    const root = await send(chat, tree.trunkBranchId, 'ROOT');
    expect(root.last.type).toBe('done');
    expect(root.begin.assistantNode.model).toBe('pool-model');
    const [reply, title] = provider.calls;
    expect(provider.kindOf(reply!)).toBe('chat');
    expect(reply!.model).toBe('pool-model');
    expect(reply!.system).toContain('LOCKED PROMPT');
    expect(reply!.system).not.toContain('IGNORE ME');
    // No summary model configured: the title runs on the branch's provider, pinned model.
    expect(provider.kindOf(title!)).toBe('title');
    expect(title!.model).toBe('pool-model');

    // A summary-mode branch: its summary is on the pinned model too.
    provider.calls.length = 0;
    const branch = await chat.createBranch({
      fromNodeId: root.begin.assistantNode.id,
      contextMode: 'summary',
    });
    expect(branch.model).toBe('m1');
    await send(chat, branch.id, 'SIDE');
    expect(provider.calls.map((c) => [provider.kindOf(c), c.model])).toEqual([
      ['summary', 'pool-model'],
      ['chat', 'pool-model'],
      ['title', 'pool-model'],
    ]);

    const plan = await chat.planContext(branch.id, null, { resolveSummaries: false });
    expect(plan.model).toBe('pool-model');
    expect(plan.rendered.system).toContain('LOCKED PROMPT');

    const stored = await repos.trees.getTree(tree.id);
    expect(stored?.systemPrompt).toBe('IGNORE ME TOO');
    expect((await repos.trees.getBranch(tree.trunkBranchId))?.model).toBe('m1');
  });

  it('plans a system node (e.g. from an imported backup) as a user turn under the locked prompt', async () => {
    const { chat, provider } = setup(PINNED);
    const { tree } = await chat.createTree({});
    const backup = await chat.exportBackup(tree.id);
    const restored = await chat.importBackup({
      ...backup,
      nodes: [
        {
          id: 'sys',
          treeId: tree.id,
          branchId: tree.trunkBranchId,
          parentId: null,
          seq: 0,
          role: 'system',
          content: 'INJECTED RULES',
          status: 'complete',
          error: null,
          providerId: null,
          model: null,
          usage: null,
          createdAt: backup.exportedAt,
        },
      ],
    });
    await send(chat, restored.tree.trunkBranchId, 'ROOT');
    const reply = provider.calls[0]!;
    expect(reply.system).toBe('LOCKED PROMPT');
    expect(reply.messages[0]?.content).toContain('INJECTED RULES');
  });

  it('clips an anchor quote to the pool message limit in the same units as the message check', async () => {
    const { chat } = setup({
      profile: {
        kind: 'pool',
        model: 'pool-model',
        systemPrompt: 'LOCKED PROMPT',
        estimateTokens,
        anchorQuoteMaxChars: 20,
      },
    });
    const { tree } = await chat.createTree({});
    const root = await send(chat, tree.trunkBranchId, 'ROOT');
    const side = await chat.createBranch({
      fromNodeId: root.begin.assistantNode.id,
      anchorQuote: '😀'.repeat(40),
    });
    const plan = await chat.planContext(side.id, null, { resolveSummaries: false });
    const anchor = plan.plan.segments.find((s) => s.kind === 'anchor');
    // At most 20 UTF-16 units, as `content.length` counts a message: nine emoji (18 units)
    // and the ellipsis, since a tenth would leave half a pair.
    expect(anchor?.text).toBe(`${'😀'.repeat(9)}…`);
  });

  it('without them, the branch model and the tree prompt are used', async () => {
    const { chat, provider } = setup();
    const { tree } = await chat.createTree({ systemPrompt: 'MY PROMPT', model: 'm1' });
    await send(chat, tree.trunkBranchId, 'ROOT');
    expect(provider.calls[0]!.model).toBe('m1');
    expect(provider.calls[0]!.system).toContain('MY PROMPT');
  });

  it("passes the caller's reservation on the reply only", async () => {
    const { chat, provider } = setup(PINNED);
    const { tree } = await chat.createTree({});
    const begin = await chat.beginSend(tree.trunkBranchId, 'ROOT');
    const events = await collect(
      chat.runGeneration(begin, new AbortController().signal, { reservationId: 'res-1' }),
    );
    expect(events.at(-1)?.type).toBe('done');
    expect(provider.calls.map((c) => [provider.kindOf(c), c.usageTag?.reservationId])).toEqual([
      ['chat', 'res-1'],
      ['title', undefined],
    ]);
  });

  it('a refused title call (e.g. the pool) leaves the default title; the send completes', async () => {
    const { chat, provider, repos } = setup(PINNED);
    provider.refuseTitles = true;
    const { tree } = await chat.createTree({});
    const root = await send(chat, tree.trunkBranchId, 'ROOT');
    expect(root.last.type).toBe('done');
    expect(provider.calls.map((c) => provider.kindOf(c))).toEqual(['chat', 'title']);
    expect((await repos.trees.getTree(tree.id))?.title).toBe(tree.title);
  });
});
