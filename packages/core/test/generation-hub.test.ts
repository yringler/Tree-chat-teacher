import type { Branch, ChatNode, StreamEvent } from '@tangent/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenerationHub, replayEvents, type GenerationSink } from '../src/generation/hub.js';
import type { BeginSendResult } from '../src/generation/send.js';

const branch = { id: 'b' } as Branch;
const node = (over: Partial<ChatNode> = {}): ChatNode =>
  ({ id: 'a', branchId: 'b', content: '', status: 'streaming', error: null, ...over }) as ChatNode;
const begin: BeginSendResult = { branch, userNode: node({ id: 'u' }), assistantNode: node() };

/** A sink that records what it gets; `fail` makes its writes throw (a reader gone away). */
function recorder(fail = false) {
  const got: string[] = [];
  const sink: GenerationSink = {
    write(e) {
      if (fail) throw new Error('gone');
      got.push(e.type === 'delta' ? `delta:${e.text}` : e.type);
      if (e.type === 'snapshot') got.push(`content:${e.node.content}`);
    },
    close: () => void got.push('closed'),
    ping: () => void got.push('ping'),
  };
  return { sink, got };
}

/** A generation the test feeds event by event; it ends with `done`, or `error` once aborted. */
function scripted() {
  const queue: StreamEvent[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const push = (...events: StreamEvent[]) => {
    queue.push(...events);
    wake?.();
  };
  return {
    delta: (text: string) => push({ type: 'delta', nodeId: 'a', text }),
    end: () => {
      ended = true;
      push({ type: 'done', node: node({ content: 'final', status: 'complete' }), branch });
    },
    async *generate(signal: AbortSignal): AsyncIterable<StreamEvent> {
      signal.addEventListener('abort', () => {
        ended = true;
        push({ type: 'error', nodeId: 'a', message: 'Stopped', node: node({ status: 'error' }) });
      });
      for (;;) {
        while (queue.length) {
          const e = queue.shift()!;
          yield e;
          if (e.type === 'done' || e.type === 'error') return;
        }
        if (ended && !queue.length) return;
        await new Promise<void>((r) => (wake = r));
      }
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe('GenerationHub', () => {
  it("fans a run's events out to its readers; a reconnecting reader starts from a snapshot", async () => {
    const hub = new GenerationHub();
    const gen = scripted();
    const first = recorder();
    const finished = hub.start(begin, 'own-key', first.sink, (s) => gen.generate(s));
    expect(hub.size).toBe(1);
    gen.delta('Hel');
    await tick();
    const second = recorder();
    expect(hub.attach('a', second.sink)).toBe(true);
    gen.delta('lo');
    gen.end();
    await finished;
    expect(first.got).toEqual(['start', 'delta:Hel', 'delta:lo', 'done', 'closed']);
    expect(second.got).toEqual(['snapshot', 'content:Hel', 'delta:lo', 'done', 'closed']);
    expect(hub.size).toBe(0);
    expect(hub.attach('a', recorder().sink)).toBe(false);
  });

  it('drops a reader that went away or detached, and keeps generating for the rest', async () => {
    const hub = new GenerationHub();
    const gen = scripted();
    const gone = recorder(true);
    const finished = hub.start(begin, 'own-key', gone.sink, (s) => gen.generate(s));
    const left = recorder();
    const stays = recorder();
    hub.attach('a', left.sink);
    hub.attach('a', stays.sink);
    expect(hub.detach('a', left.sink)).toBe(true);
    expect(hub.detach('a', left.sink)).toBe(false);
    gen.delta('x');
    gen.end();
    await finished;
    expect(gone.got).toEqual([]);
    expect(left.got).toEqual(['snapshot', 'content:']);
    expect(stays.got).toEqual(['snapshot', 'content:', 'delta:x', 'done', 'closed']);
  });

  it('cancels one run, and stops the matching runs once they have settled', async () => {
    const hub = new GenerationHub();
    const gen = scripted();
    const settled: string[] = [];
    const reader = recorder();
    void hub.start(begin, 'own-key', reader.sink, (s) => gen.generate(s), {
      settle: async () => {
        await tick();
        settled.push('settled');
      },
    });
    expect(hub.cancel('missing')).toBe(false);
    await hub.stop((n) => n.branchId === 'other');
    expect(hub.size).toBe(1);
    await hub.stop((n) => n.branchId === 'b');
    expect(settled).toEqual(['settled']);
    expect(reader.got).toEqual(['start', 'error', 'closed']);
    expect(hub.size).toBe(0);
    expect(hub.cancel('a')).toBe(false);
  });

  it('pings idle readers every keepAliveMs', async () => {
    vi.useFakeTimers();
    const hub = new GenerationHub({ keepAliveMs: 1000 });
    const gen = scripted();
    const reader = recorder();
    const finished = hub.start(begin, 'own-key', reader.sink, (s) => gen.generate(s));
    await vi.advanceTimersByTimeAsync(2500);
    gen.end();
    await finished;
    await vi.advanceTimersByTimeAsync(2000);
    expect(reader.got).toEqual(['start', 'ping', 'ping', 'done', 'closed']);
  });
});

describe('replayEvents', () => {
  it('replays a finished reply as snapshot and done, anything else as snapshot and error', () => {
    const done = node({ status: 'complete', content: 'x' });
    expect(replayEvents(done, branch).map((e) => e.type)).toEqual(['snapshot', 'done']);
    const failed = node({ status: 'error', error: 'Boom' });
    expect(replayEvents(failed, branch)[1]).toMatchObject({ type: 'error', message: 'Boom' });
    expect(replayEvents(done, null)[1]).toMatchObject({ message: 'Generation failed' });
  });
});
