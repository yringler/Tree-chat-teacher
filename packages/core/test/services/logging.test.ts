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
});
