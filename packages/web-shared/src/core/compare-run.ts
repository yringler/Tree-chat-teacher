import { signal, type Signal, type WritableSignal } from '@angular/core';
import type { CandidateRequest, CommitCandidateResponse } from '@tangent/shared';
import { parseCandidateEvent, readSseEvents } from '../sse/sse-parser';
import { ApiError, errorMessage, type ApiClient } from './api-client';

/** One answer to ask for: who answers (`request`: model and route) and how it is labelled. */
export interface CompareSpec {
  id: string;
  /** e.g. "Normal". */
  label: string;
  /** e.g. the model's name. */
  sublabel?: string;
  request: CandidateRequest;
}

/** Where one answer of a CompareRun is. */
export interface CompareCandidateState {
  id: string;
  label: string;
  sublabel?: string;
  /** pending = not asked yet; streaming = asked, not finished. */
  state: 'pending' | 'streaming' | 'done' | 'error';
  /** The answer's text so far (Markdown). */
  content: string;
  /** Latest progress note (e.g. "Summarizing…"), cleared once text arrives. */
  status: string | null;
  error: string | null;
  /** The HTTP refusal (402, 403, 429, …) when the request failed before streaming. */
  refusal: ApiError | null;
  /** Set on `done`: what the commit route takes. */
  candidateId: string | null;
  /** The model asked for; on `done`, the one that answered. */
  model: string;
}

/**
 * One Compare: the same question to several models (Normal and Max) as
 * candidate replies at the branch's leaf, then the commit of the one picked.
 * Both apps drive their Compare dialog with it.
 *
 * Starts are staggered: each candidate is asked once the previous one has
 * streamed its first text (or ended), so the summaries both need are made
 * once and cached by the first, and the metered calls in flight stay few.
 * Plain class (no DI) so it can be unit tested; state is in signals.
 */
export class CompareRun {
  private readonly state: WritableSignal<readonly CompareCandidateState[]>;
  private readonly committingState = signal(false);
  private readonly controllers = new Map<string, AbortController>();
  /** No new candidate starts once set (abort or commit). */
  private stopped = false;

  readonly candidates: Signal<readonly CompareCandidateState[]>;
  /** A pick is being committed. */
  readonly committing = this.committingState.asReadonly();

  constructor(
    private readonly api: Pick<ApiClient, 'streamCandidate' | 'commitCandidate'>,
    readonly branchId: string,
    readonly question: string,
    private readonly specs: readonly CompareSpec[],
  ) {
    this.state = signal(
      specs.map((s): CompareCandidateState => ({
        id: s.id,
        label: s.label,
        ...(s.sublabel !== undefined ? { sublabel: s.sublabel } : {}),
        state: 'pending',
        content: '',
        status: null,
        error: null,
        refusal: null,
        candidateId: null,
        model: s.request.model,
      })),
    );
    this.candidates = this.state.asReadonly();
  }

  /** Asks every candidate, one after another (see the class comment); resolves when all ended. */
  async start(): Promise<void> {
    const runs: Promise<void>[] = [];
    for (const spec of this.specs) {
      if (this.stopped) break;
      let release = (): void => undefined;
      const started = new Promise<void>((resolve) => (release = resolve));
      runs.push(this.run(spec, release));
      await started;
    }
    await Promise.all(runs);
  }

  /** Stops every candidate still running (the server drops them); idempotent. */
  abort(): void {
    this.stopped = true;
    for (const ctrl of this.controllers.values()) ctrl.abort();
    this.controllers.clear();
  }

  /**
   * Keeps candidate `id` (it must be `done`): stops the others and appends the
   * question and its answer to the branch. Rethrows the API's refusal (404,
   * 409 the branch moved on, 410 expired, 403 on the pool). An unfinished
   * other ends as `error` "Stopped", so a host that stays open after a failed
   * commit (to let the pick be retried) shows no answer still writing.
   */
  async commit(id: string): Promise<CommitCandidateResponse> {
    const picked = this.state().find((c) => c.id === id);
    if (!picked || picked.state !== 'done' || !picked.candidateId)
      throw new Error('That answer is not finished yet');
    if (this.committingState()) throw new Error('An answer is already being saved');
    this.stopped = true;
    for (const [other, ctrl] of this.controllers) if (other !== id) ctrl.abort();
    this.state.update((list) =>
      list.map((c) =>
        c.id !== id && (c.state === 'pending' || c.state === 'streaming')
          ? { ...c, state: 'error', status: null, error: 'Stopped' }
          : c,
      ),
    );
    this.committingState.set(true);
    try {
      return await this.api.commitCandidate(this.branchId, picked.candidateId);
    } catch (err) {
      // On success the flag stays set: the host closes the dialog.
      this.committingState.set(false);
      throw err;
    }
  }

  /** Streams one candidate; `release` lets the next one start (first text, or the end). */
  private async run(spec: CompareSpec, release: () => void): Promise<void> {
    const ctrl = new AbortController();
    this.controllers.set(spec.id, ctrl);
    const patch = (p: Partial<CompareCandidateState>): void => {
      if (!ctrl.signal.aborted) this.patch(spec.id, p);
    };
    patch({ state: 'streaming' });
    let ended = false;
    try {
      const res = await this.api.streamCandidate(this.branchId, spec.request, ctrl.signal);
      if (!res.body) throw new Error('Empty answer stream');
      for await (const event of readSseEvents(res.body, parseCandidateEvent)) {
        if (ctrl.signal.aborted) return;
        switch (event.type) {
          case 'status':
            patch({ status: event.message });
            break;
          case 'delta':
            patch({ content: (this.get(spec.id)?.content ?? '') + event.text, status: null });
            release();
            break;
          case 'done':
            patch({
              state: 'done',
              status: null,
              candidateId: event.candidateId,
              model: event.model,
            });
            ended = true;
            break;
          case 'error':
            patch({ state: 'error', status: null, error: event.message });
            ended = true;
            break;
        }
      }
      if (!ended && !ctrl.signal.aborted)
        throw new Error('The connection closed before the answer finished');
    } catch (err) {
      if (ctrl.signal.aborted) return;
      patch({
        state: 'error',
        status: null,
        error: errorMessage(err),
        refusal: err instanceof ApiError && err.status > 0 ? err : null,
      });
    } finally {
      if (this.controllers.get(spec.id) === ctrl) this.controllers.delete(spec.id);
      release();
    }
  }

  private get(id: string): CompareCandidateState | undefined {
    return this.state().find((c) => c.id === id);
  }

  private patch(id: string, patch: Partial<CompareCandidateState>): void {
    this.state.update((list) => list.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }
}
