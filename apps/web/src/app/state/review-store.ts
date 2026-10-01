import { inject, Injectable, signal } from '@angular/core';
import type { ProviderInfo, TokenUsage } from '@tangent/shared';
import { ApiClient, ApiError, errorMessage } from '../core/api-client';
import { parseReviewEvent, readSseEvents } from '../sse/sse-parser';
import { type ModelChoice, SettingsStore } from './settings-store';
import { TreeStore } from './tree-store';
import { UiStore } from './ui-store';

export interface ReviewState {
  /** The reviewed assistant message. */
  nodeId: string;
  providerId: string;
  model: string;
  phase: 'running' | 'done' | 'error';
  /** Raw review text so far (trailer included; see parseReview). */
  text: string;
  /** Latest progress note (e.g. "Summarizing…"), cleared once text arrives. */
  status: string | null;
  error: string | null;
  usage: TokenUsage | null;
}

/** Usable for generation: has a key and lists the model (or lists none). */
function offers(p: ProviderInfo | undefined, model: string): p is ProviderInfo {
  return !!p && p.available && (p.models.length === 0 || p.models.some((m) => m.id === model));
}

/**
 * Reviews of assistant messages, one per message, kept for this session
 * only. A review keeps running when its dialog closes; reopening shows it.
 */
@Injectable({ providedIn: 'root' })
export class ReviewStore {
  private readonly api = inject(ApiClient);
  private readonly tree = inject(TreeStore);
  private readonly ui = inject(UiStore);
  private readonly settings = inject(SettingsStore);

  readonly reviews = signal<ReadonlyMap<string, ReviewState>>(new Map());
  private readonly controllers = new Map<string, AbortController>();

  /**
   * Reviewer to preselect: the saved setting while it is still usable, else
   * the default model of `branchProviderId`, else of any provider with a key.
   */
  defaultReviewer(branchProviderId: string | null): ModelChoice | null {
    const providers = this.tree.providerMap();
    const saved = this.settings.settings().reviewer;
    if (saved && offers(providers.get(saved.providerId), saved.model)) return saved;
    const own = branchProviderId ? providers.get(branchProviderId) : undefined;
    const fallback = own?.available ? own : this.tree.providers().find((p) => p.available);
    return fallback ? { providerId: fallback.id, model: fallback.defaultModel } : null;
  }

  async start(nodeId: string, choice: ModelChoice): Promise<void> {
    this.stop(nodeId);
    const ctrl = new AbortController();
    this.controllers.set(nodeId, ctrl);
    // A stopped or restarted run must not write over its successor.
    const current = () => this.controllers.get(nodeId) === ctrl;
    const patch = (p: Partial<ReviewState>) => current() && this.patch(nodeId, p);
    this.put({
      nodeId,
      ...choice,
      phase: 'running',
      text: '',
      status: 'Starting…',
      error: null,
      usage: null,
    });
    let finished = false;
    try {
      const res = await this.api.reviewNode(nodeId, choice, ctrl.signal);
      if (!res.body) throw new Error('Empty review stream');
      for await (const event of readSseEvents(res.body, parseReviewEvent)) {
        if (!current()) return;
        switch (event.type) {
          case 'status':
            patch({ status: event.message });
            break;
          case 'delta':
            patch({ text: (this.get(nodeId)?.text ?? '') + event.text, status: null });
            break;
          case 'done':
            patch({ phase: 'done', status: null, usage: event.usage });
            finished = true;
            break;
          case 'error':
            patch({ phase: 'error', status: null, error: event.message });
            finished = true;
            break;
        }
      }
      if (!finished && current())
        throw new Error('The connection closed before the review finished');
    } catch (err) {
      if (!current()) return;
      patch({ phase: 'error', status: null, error: errorMessage(err) });
      if (err instanceof ApiError && err.code === 'key_required' && !this.ui.keysDialog()) {
        this.ui.keysDialog.set({ provider: choice.providerId });
      }
      this.tree.fail(err);
    } finally {
      if (current()) this.controllers.delete(nodeId);
    }
  }

  /** Aborts a running review; the server stops the upstream request. */
  stop(nodeId: string): void {
    const ctrl = this.controllers.get(nodeId);
    if (!ctrl) return;
    this.controllers.delete(nodeId);
    ctrl.abort();
    if (this.get(nodeId)?.phase === 'running') {
      this.patch(nodeId, { phase: 'error', status: null, error: 'Stopped' });
    }
  }

  get(nodeId: string): ReviewState | undefined {
    return this.reviews().get(nodeId);
  }

  private put(state: ReviewState): void {
    this.reviews.update((m) => new Map(m).set(state.nodeId, state));
  }

  private patch(nodeId: string, patch: Partial<ReviewState>): void {
    const cur = this.get(nodeId);
    if (cur) this.put({ ...cur, ...patch });
  }
}
