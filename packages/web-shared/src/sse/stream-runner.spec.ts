import { describe, expect, it } from 'vitest';
import type { ChatNode, StreamEvent } from '@tangent/shared';
import { runStream } from './stream-runner';
import * as fixtures from '../testing';
import { sse } from '../testing';

const branch = fixtures.branch('b1', { title: 'Trunk' });

/** Message `id` of branch `b1`. */
const node = (
  id: string,
  role: ChatNode['role'],
  content: string,
  status: ChatNode['status'],
): ChatNode => fixtures.node(id, { branchId: 'b1', role, content, status });

/** A Response whose body emits `text` and then either closes or errors. */
function response(text: string, fail = false): Response {
  const enc = new TextEncoder();
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(enc.encode(text));
      } else if (fail) controller.error(new Error('network reset'));
      else controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

const start: StreamEvent = {
  type: 'start',
  userNode: node('u1', 'user', 'hi', 'complete'),
  assistantNode: node('a1', 'assistant', '', 'streaming'),
  branch,
  funding: 'own-key',
};
const noSleep = (): Promise<void> => Promise.resolve();

describe('runStream', () => {
  it('returns done after a clean stream', async () => {
    const events: StreamEvent[] = [];
    const outcome = await runStream(
      {
        open: () =>
          Promise.resolve(
            response(
              sse([
                start,
                { type: 'delta', nodeId: 'a1', text: 'Hel' },
                { type: 'delta', nodeId: 'a1', text: 'lo' },
                { type: 'done', node: node('a1', 'assistant', 'Hello', 'complete'), branch },
              ]),
            ),
          ),
        reconnect: () => Promise.reject(new Error('should not reconnect')),
        sleep: noSleep,
      },
      (e) => events.push(e),
    );
    expect(outcome).toEqual({ kind: 'done' });
    expect(events.map((e) => e.type)).toEqual(['start', 'delta', 'delta', 'done']);
  });

  it('reconnects with the assistant node id after a drop and continues from the snapshot', async () => {
    const reconnectIds: string[] = [];
    const events: StreamEvent[] = [];
    const outcome = await runStream(
      {
        open: () =>
          Promise.resolve(
            response(sse([start, { type: 'delta', nodeId: 'a1', text: 'Hel' }]), true),
          ),
        reconnect: (id) => {
          reconnectIds.push(id);
          return Promise.resolve(
            response(
              sse([
                { type: 'snapshot', node: node('a1', 'assistant', 'Hel', 'streaming') },
                { type: 'delta', nodeId: 'a1', text: 'lo' },
                { type: 'done', node: node('a1', 'assistant', 'Hello', 'complete'), branch },
              ]),
            ),
          );
        },
        sleep: noSleep,
      },
      (e) => events.push(e),
    );
    expect(outcome).toEqual({ kind: 'done' });
    expect(reconnectIds).toEqual(['a1']);
    expect(events.map((e) => e.type)).toEqual(['start', 'delta', 'snapshot', 'delta', 'done']);
  });

  it('gives up after maxReconnects', async () => {
    let calls = 0;
    const delays: number[] = [];
    const outcome = await runStream(
      {
        open: () => Promise.resolve(response(sse([start]))),
        reconnect: () => {
          calls++;
          return Promise.reject(new Error('offline'));
        },
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      },
      () => undefined,
      { maxReconnects: 3, baseDelayMs: 100 },
    );
    expect(outcome).toEqual({ kind: 'lost', message: 'offline' });
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200, 400]);
  });

  it('stops on a permanent HTTP error', async () => {
    let calls = 0;
    const err = Object.assign(new Error('Node not found'), { status: 404 });
    const outcome = await runStream(
      {
        open: () => Promise.resolve(response(sse([start]))),
        reconnect: () => {
          calls++;
          return Promise.reject(err);
        },
        sleep: noSleep,
      },
      () => undefined,
    );
    expect(outcome).toEqual({ kind: 'lost', message: 'Node not found' });
    expect(calls).toBe(1);
  });

  it('propagates errors from the initial request', async () => {
    await expect(
      runStream(
        {
          open: () => Promise.reject(new Error('conflict')),
          reconnect: () => Promise.reject(new Error('x')),
        },
        () => undefined,
      ),
    ).rejects.toThrow('conflict');
  });

  it('can resume an existing node without an initial request', async () => {
    const events: StreamEvent[] = [];
    const outcome = await runStream(
      {
        open: null,
        reconnect: () =>
          Promise.resolve(
            response(
              sse([
                { type: 'snapshot', node: node('a1', 'assistant', 'partial', 'error') },
                { type: 'error', nodeId: 'a1', message: 'interrupted', node: null },
              ]),
            ),
          ),
        sleep: noSleep,
      },
      (e) => events.push(e),
      { nodeId: 'a1' },
    );
    expect(outcome).toEqual({ kind: 'error', message: 'interrupted' });
    expect(events).toHaveLength(2);
  });

  it('reports aborted when the signal fires', async () => {
    const ctrl = new AbortController();
    const outcome = await runStream(
      {
        open: () => {
          ctrl.abort();
          return Promise.resolve(response(sse([start]), true));
        },
        reconnect: () => Promise.reject(new Error('x')),
        sleep: noSleep,
      },
      () => undefined,
      { signal: ctrl.signal },
    );
    expect(outcome).toEqual({ kind: 'aborted' });
  });
});
