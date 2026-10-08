import '@angular/compiler'; // JIT: the shared index below pulls in decorated classes.
import type { CandidateEvent, CandidateRequest, CommitCandidateResponse } from '@tangent/shared';
import { describe, expect, it, vi } from 'vitest';
import * as shared from '../index';
import { ApiError } from './api-client';
import { CompareRun, type CompareSpec } from './compare-run';

const encoder = new TextEncoder();

function frame(event: CandidateEvent): Uint8Array {
  return encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function done(candidateId: string, model: string): CandidateEvent {
  return {
    type: 'done',
    candidateId,
    providerId: 'openrouter',
    funding: 'own-key',
    model,
    usage: null,
    sources: null,
    expiresAt: '2026-01-01T00:30:00.000Z',
  };
}

/** A candidate stream the test writes to; aborting the request errors it, like fetch. */
class FakeStream {
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  readonly response: Response;
  constructor(signal: AbortSignal) {
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.controller = c;
      },
    });
    signal.addEventListener('abort', () => {
      try {
        this.controller.error(new DOMException('The operation was aborted.', 'AbortError'));
      } catch {
        // Already closed.
      }
    });
    this.response = new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }
  send(event: CandidateEvent): void {
    this.controller.enqueue(frame(event));
  }
  end(): void {
    this.controller.close();
  }
}

const COMMITTED = {
  userNode: { id: 'u' },
  assistantNode: { id: 'a' },
  branch: { id: 'b1' },
} as unknown as CommitCandidateResponse;

function fakeApi() {
  const streams = new Map<string, FakeStream>();
  const signals = new Map<string, AbortSignal>();
  const asked: string[] = [];
  const refusals = new Map<string, ApiError>();
  const api = {
    streamCandidate: vi.fn(
      async (_branchId: string, req: CandidateRequest, signal: AbortSignal) => {
        asked.push(req.model);
        const refusal = refusals.get(req.model);
        if (refusal) throw refusal;
        const stream = new FakeStream(signal);
        streams.set(req.model, stream);
        signals.set(req.model, signal);
        return stream.response;
      },
    ),
    commitCandidate: vi.fn(async (_branchId: string, _candidateId: string) => COMMITTED),
  };
  return { api, streams, signals, asked, refusals };
}

const SPECS: readonly CompareSpec[] = [
  { id: 'normal', label: 'Normal', request: { content: 'Why?', model: 'pro' } },
  { id: 'max', label: 'Max', sublabel: 'Sonnet', request: { content: 'Why?', model: 'sonnet' } },
];

/** Lets pending promises and stream reads settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('CompareRun', () => {
  it('is exported for the apps', () => {
    expect(shared.CompareRun).toBe(CompareRun);
  });

  it('starts every candidate pending, labelled, on its requested model', () => {
    const { api } = fakeApi();
    const run = new CompareRun(api, 'b1', 'Why?', SPECS);
    expect(run.branchId).toBe('b1');
    expect(run.question).toBe('Why?');
    expect(run.committing()).toBe(false);
    expect(run.candidates()).toEqual([
      {
        id: 'normal',
        label: 'Normal',
        state: 'pending',
        content: '',
        status: null,
        error: null,
        refusal: null,
        candidateId: null,
        model: 'pro',
      },
      {
        id: 'max',
        label: 'Max',
        sublabel: 'Sonnet',
        state: 'pending',
        content: '',
        status: null,
        error: null,
        refusal: null,
        candidateId: null,
        model: 'sonnet',
      },
    ]);
  });

  it('asks the second candidate only once the first has streamed text, then streams both', async () => {
    const { api, streams, asked } = fakeApi();
    const run = new CompareRun(api, 'b1', 'Why?', SPECS);
    const finished = run.start();
    await settle();
    expect(asked).toEqual(['pro']);
    streams.get('pro')!.send({ type: 'status', message: 'Summarizing…' });
    await settle();
    expect(asked).toEqual(['pro']); // a status is not text: the summaries may still be on their way
    expect(run.candidates()[0]).toMatchObject({ state: 'streaming', status: 'Summarizing…' });
    expect(run.candidates()[1]!.state).toBe('pending');

    streams.get('pro')!.send({ type: 'delta', text: 'Because ' });
    await settle();
    expect(asked).toEqual(['pro', 'sonnet']);
    expect(api.streamCandidate.mock.calls[1]![1]).toEqual(SPECS[1]!.request);
    streams.get('pro')!.send({ type: 'delta', text: 'light.' });
    streams.get('sonnet')!.send({ type: 'delta', text: 'Rayleigh.' });
    streams.get('pro')!.send(done('c-pro', 'pro'));
    streams.get('pro')!.end();
    streams.get('sonnet')!.send(done('c-sonnet', 'sonnet-actual'));
    streams.get('sonnet')!.end();
    await finished;

    expect(run.candidates()).toMatchObject([
      {
        state: 'done',
        content: 'Because light.',
        status: null,
        candidateId: 'c-pro',
        model: 'pro',
      },
      {
        state: 'done',
        content: 'Rayleigh.',
        candidateId: 'c-sonnet',
        model: 'sonnet-actual',
      },
    ]);
    expect(api.streamCandidate.mock.calls.every(([branchId]) => branchId === 'b1')).toBe(true);
  });

  it('asks the next candidate when the previous one ends without text', async () => {
    const { api, streams, asked } = fakeApi();
    const run = new CompareRun(api, 'b1', 'Why?', SPECS);
    const finished = run.start();
    await settle();
    streams.get('pro')!.send({ type: 'error', message: 'Upstream failed' });
    streams.get('pro')!.end();
    await settle();
    expect(asked).toEqual(['pro', 'sonnet']);
    expect(run.candidates()[0]).toMatchObject({
      state: 'error',
      error: 'Upstream failed',
      refusal: null,
    });
    streams.get('sonnet')!.send(done('c2', 'sonnet'));
    streams.get('sonnet')!.end();
    await finished;
    expect(run.candidates()[1]!.state).toBe('done');
  });

  it('keeps an HTTP refusal on its candidate and still asks the next one', async () => {
    const { api, streams, refusals } = fakeApi();
    const refusal = new ApiError(402, 'payment_required', 'Add credit to keep learning');
    refusals.set('pro', refusal);
    const run = new CompareRun(api, 'b1', 'Why?', SPECS);
    const finished = run.start();
    await settle();
    expect(run.candidates()[0]).toMatchObject({
      state: 'error',
      refusal,
      error: 'Add credit to keep learning',
    });
    streams.get('sonnet')!.send(done('c2', 'sonnet'));
    streams.get('sonnet')!.end();
    await finished;
  });

  it('calls a stream that closes before `done` an error', async () => {
    const { api, streams } = fakeApi();
    const run = new CompareRun(api, 'b1', 'Why?', SPECS.slice(0, 1));
    const finished = run.start();
    await settle();
    streams.get('pro')!.send({ type: 'delta', text: 'Half' });
    streams.get('pro')!.end();
    await finished;
    expect(run.candidates()[0]).toMatchObject({
      state: 'error',
      content: 'Half',
      error: 'The connection closed before the answer finished',
      refusal: null,
    });
  });

  it('abort() stops what is running and starts nothing more; nothing turns into an error', async () => {
    const { api, signals, asked } = fakeApi();
    const run = new CompareRun(api, 'b1', 'Why?', SPECS);
    const finished = run.start();
    await settle();
    run.abort();
    run.abort(); // idempotent
    await finished;
    expect(signals.get('pro')!.aborted).toBe(true);
    expect(asked).toEqual(['pro']);
    expect(run.candidates().map((c) => [c.state, c.error])).toEqual([
      ['streaming', null],
      ['pending', null],
    ]);
  });

  it('commit() keeps a finished candidate: stops the others and posts its candidate id', async () => {
    const { api, streams, signals } = fakeApi();
    const run = new CompareRun(api, 'b1', 'Why?', SPECS);
    const finished = run.start();
    await settle();
    streams.get('pro')!.send({ type: 'delta', text: 'Because.' });
    streams.get('pro')!.send(done('c-pro', 'pro'));
    streams.get('pro')!.end();
    await settle();
    streams.get('sonnet')!.send({ type: 'delta', text: 'Still writing' });
    await settle();

    await expect(run.commit('max')).rejects.toThrow('not finished');
    const committed = run.commit('normal');
    expect(run.committing()).toBe(true);
    await expect(committed).resolves.toBe(COMMITTED);
    expect(api.commitCandidate).toHaveBeenCalledWith('b1', 'c-pro');
    expect(signals.get('sonnet')!.aborted).toBe(true);
    await finished;
    // The stopped one ends (no answer left writing), keeping what it had.
    expect(run.candidates()[1]).toMatchObject({
      state: 'error',
      error: 'Stopped',
      content: 'Still writing',
    });
    expect(run.candidates()[0]!.state).toBe('done');
  });

  it('commit() rethrows the refusal and lets the user pick again', async () => {
    const { api, streams } = fakeApi();
    const gone = new ApiError(410, 'gone', 'That comparison has expired');
    api.commitCandidate.mockRejectedValueOnce(gone);
    const run = new CompareRun(api, 'b1', 'Why?', SPECS.slice(0, 1));
    const finished = run.start();
    await settle();
    streams.get('pro')!.send(done('c-pro', 'pro'));
    streams.get('pro')!.end();
    await finished;
    await expect(run.commit('normal')).rejects.toBe(gone);
    expect(run.committing()).toBe(false);
  });
});
