import { computed, inject, Injectable, signal } from '@angular/core';
import {
  ANTHROPIC_PROVIDER_ID,
  DEFAULT_LEARN_REPLY,
  learnReplyIndicator,
  type LearnReplyContext,
  type LearnReplySettings,
} from '@tangent/shared';
import { ApiClient, ToastStore } from '@tangent/web-shared';
import { LearnFunding } from './learn-funding';

/**
 * The learner's reply settings (Advanced settings: the model tier and the
 * reply length), saved with the account through `/api/settings`. The server
 * reads them for each reply it pays from the learner's key or credit, so
 * this store only shows and saves them; until they load, the defaults show.
 */
@Injectable({ providedIn: 'root' })
export class ReplySettings {
  private readonly api = inject(ApiClient);
  private readonly toast = inject(ToastStore);
  private readonly funding = inject(LearnFunding);

  readonly settings = signal<LearnReplySettings>(DEFAULT_LEARN_REPLY);

  /** Where replies are paid now, as far as the settings care. */
  readonly context = computed<LearnReplyContext>(() => ({
    pool: this.funding.payer() === 'pool',
    fixedModel:
      this.funding.payer() === 'own-key' && this.funding.replyKey() === ANTHROPIC_PROVIDER_ID,
  }));

  /** The composer chip: null while every setting that applies is the default. */
  readonly indicator = computed(() => learnReplyIndicator(this.settings(), this.context()));

  /** Whether any setting differs from the default, wherever replies are paid. */
  readonly changed = computed(() => {
    const s = this.settings();
    return s.tier !== DEFAULT_LEARN_REPLY.tier || s.replyLength !== DEFAULT_LEARN_REPLY.replyLength;
  });

  async load(): Promise<void> {
    this.settings.set((await this.api.settings()).learn);
  }

  /** Counts saves, so only the latest one's answer is shown. */
  private saves = 0;

  /**
   * Saves `patch` at once, showing it before the server answers; a refused
   * save goes back to what was shown before it and says so.
   */
  async save(patch: Partial<LearnReplySettings>): Promise<void> {
    const before = this.settings();
    const seq = ++this.saves;
    this.settings.set({ ...before, ...patch });
    try {
      const saved = (await this.api.updateSettings({ learn: patch })).learn;
      if (seq === this.saves) this.settings.set(saved);
    } catch (err) {
      if (seq === this.saves) this.settings.set(before);
      this.toast.notify(err instanceof Error ? err.message : String(err), 'error');
    }
  }
}
