import { describe, expect, it } from 'vitest';
import { send, setup } from './helpers.js';

type Logged = [event: string, fields: Record<string, unknown>];

function logged() {
  const lines: Logged[] = [];
  return {
    lines,
    log: (event: string, fields: Record<string, unknown>) => lines.push([event, fields]),
  };
}

describe('ChatService log', () => {
  it('logs a summary the provider failed, with its error', async () => {
    const { lines, log } = logged();
    const { chat, provider } = setup({ autoTitle: false }, { log });
    const { tree } = await chat.createTree({});
    const root = await send(chat, tree.trunkBranchId, 'ROOT');
    const branch = await chat.createBranch({
      fromNodeId: root.begin.assistantNode.id,
      contextMode: 'summary',
    });
    const stream = provider.stream.bind(provider);
    provider.stream = async function* (req) {
      if (provider.kindOf(req) !== 'summary') return yield* stream(req);
      yield { type: 'error', error: { code: 'rate_limit', message: 'slow down', retryable: true } };
    };
    await send(chat, branch.id, 'Q');
    expect(lines).toEqual([
      [
        'summary_failed',
        {
          treeId: tree.id,
          branchId: branch.id,
          providerId: 'scripted',
          model: 'm1',
          code: 'rate_limit',
          error: 'slow down',
        },
      ],
    ]);
  });

  it('logs a failed auto-title, which the reply survives', async () => {
    const { lines, log } = logged();
    const { chat, provider } = setup({}, { log });
    const { tree } = await chat.createTree({});
    const stream = provider.stream.bind(provider);
    provider.stream = async function* (req) {
      if (provider.kindOf(req) !== 'title') return yield* stream(req);
      throw new Error('socket closed');
    };
    const { last } = await send(chat, tree.trunkBranchId, 'Q');
    expect(last.type).toBe('done');
    expect(lines).toEqual([
      [
        'auto_title_failed',
        { treeId: tree.id, branchId: tree.trunkBranchId, error: 'socket closed' },
      ],
    ]);
  });

  it('logs a failed token count, but not one the caller aborted', async () => {
    const { lines, log } = logged();
    const { chat, provider } = setup({ autoTitle: false }, { log });
    const caps = provider.capabilities.bind(provider);
    provider.capabilities = () => ({ ...caps(), supportsTokenCount: true });
    provider.countTokens = () => Promise.reject(new Error('count failed'));
    const { tree } = await chat.createTree({});
    await send(chat, tree.trunkBranchId, 'Q');

    const aborted = new AbortController();
    aborted.abort();
    const options = { resolveSummaries: false, signal: aborted.signal };
    await chat.planContext(tree.trunkBranchId, null, options);
    expect(lines).toEqual([]);

    await chat.planContext(tree.trunkBranchId, null, { resolveSummaries: false });
    expect(lines).toEqual([
      [
        'count_tokens_failed',
        {
          treeId: tree.id,
          branchId: tree.trunkBranchId,
          providerId: 'scripted',
          model: 'm1',
          error: 'count failed',
        },
      ],
    ]);
  });

  it('does not log a summary cut short by a cancelled send', async () => {
    const { lines, log } = logged();
    const { chat, provider } = setup({ autoTitle: false }, { log });
    const { tree } = await chat.createTree({});
    const root = await send(chat, tree.trunkBranchId, 'ROOT');
    const branch = await chat.createBranch({
      fromNodeId: root.begin.assistantNode.id,
      contextMode: 'summary',
    });
    provider.delayMs = 5;
    const begin = await chat.beginSend(branch.id, 'Q');
    const cancel = new AbortController();
    const events = [];
    for await (const event of chat.runGeneration(begin, cancel.signal)) {
      events.push(event);
      if (event.type === 'status') cancel.abort();
    }
    expect(events.at(-1)).toMatchObject({ type: 'error', message: 'Cancelled' });
    expect(provider.summaryCalls()).toHaveLength(1);
    expect(lines).toEqual([]);
  });
});
