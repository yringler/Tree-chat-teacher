// Publish-time screening of share links: the classifier adapter (OpenAI's
// moderation endpoint, over raw fetch like the LLM providers) and the
// `screen` the owner's share routes give ShareService. The rules (pieces,
// batches, thresholds, verdicts) are pure, in @tangent/core's moderation
// module; this file names the provider and acts on the verdict.
import {
  DomainError,
  ValidationError,
  moderateTexts,
  type CategoryScores,
  type ModerationProvider,
  type SharePublish,
} from '@tangent/core';
import { z } from 'zod';
import { sendAlert } from '../alerts.js';
import { userIdOfAccount } from '../auth/account.js';
import { appConfig } from '../config.js';
import type { AppEnv } from '../env.js';
import { legalContactEmail } from '../http/legal-info.js';
import { logEvent } from '../log.js';
import { recordAudit, type ScreenAuditEvent } from './audit.js';
import { placeHold } from './legal-hold.js';

const MODERATION_URL = 'https://api.openai.com/v1/moderations';
const MODERATION_MODEL = 'omni-moderation-latest';
/** A publish waits on screening, so a stalled classifier fails it rather than hanging. */
const MODERATION_TIMEOUT_MS = 10_000;

/**
 * One generic answer for every refusal, a possible-CSAM one included: telling
 * the owner the category would teach evasion. It points to the export, which
 * is not screened, and to a person to write to about a mistake.
 */
export function refusedMessage(contactEmail: string): string {
  return (
    "This conversation can't be shared. You can still download the chat and share it yourself. " +
    `If you feel this share was blocked in error, you can contact ${contactEmail}.`
  );
}

/** `MODERATOR_EMAIL`, or the legal contact. */
export function moderatorEmail(env: AppEnv, origin: string): string {
  return appConfig(env).site.moderatorEmail ?? legalContactEmail(env, origin);
}
const UNAVAILABLE = 'Sharing is temporarily unavailable.';
const TOO_LONG = 'This conversation is too long to share; share a part of it.';

const score = z.number().min(0).max(1);
/**
 * Every category must be scored, so a changed response fails closed instead
 * of reading as a zero; categories the provider adds are dropped.
 */
const categoryScores = z.object({
  sexual: score,
  'sexual/minors': score,
  harassment: score,
  'harassment/threatening': score,
  hate: score,
  'hate/threatening': score,
  illicit: score,
  'illicit/violent': score,
  'self-harm': score,
  'self-harm/intent': score,
  'self-harm/instructions': score,
  violence: score,
  'violence/graphic': score,
}) satisfies z.ZodType<CategoryScores>;
const moderationResponse = z.object({
  results: z.array(z.object({ category_scores: categoryScores })),
});

export interface OpenAIModerationOptions {
  apiKey: string;
  /** Test hook; defaults to OpenAI's endpoint. */
  url?: string;
  /** Test hook. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** OpenAI's moderation endpoint as a `ModerationProvider`. Errors name the status only. */
export class OpenAIModeration implements ModerationProvider {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: OpenAIModerationOptions) {
    // Bound: calling an unbound global fetch through a property throws "Illegal invocation" in workerd.
    this.fetchFn = options.fetch ?? fetch.bind(globalThis);
  }

  async classify(inputs: readonly string[]): Promise<readonly CategoryScores[]> {
    const res = await this.fetchFn(this.options.url ?? MODERATION_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: MODERATION_MODEL, input: inputs }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? MODERATION_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Moderation HTTP ${res.status}`);
    const parsed = moderationResponse.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new Error('Moderation response not understood');
    return parsed.data.results.map((r) => r.category_scores);
  }
}

/**
 * The `screen` for ShareService, or undefined when `MODERATION_API_KEY` is
 * unset: then nothing is screened, and `sharingMode` keeps publishing to
 * admins and allowed users. Allowed publishes are recorded with their scores
 * in the audit log. Refused ones get one generic message whatever the
 * reason; possible child sexual abuse material is also put on legal hold
 * (the refused snapshot, the conversation and the owner's account) and
 * alerted to the operator, and the owner is not told. A classifier failure
 * refuses too (fail closed). `origin` is the public origin, for the alert's
 * admin link.
 */
export function shareScreen(
  env: AppEnv,
  origin: string,
): ((publish: SharePublish) => Promise<void>) | undefined {
  const { moderationApiKey: apiKey, moderationUrl: url } = appConfig(env).site;
  if (!apiKey) return undefined;
  const provider = new OpenAIModeration({ apiKey, ...(url ? { url } : {}) });
  const refused = refusedMessage(moderatorEmail(env, origin));
  return async ({ trigger, share, payload, texts }) => {
    const subjectUserId = userIdOfAccount(share.accountId);
    const verdict = await moderateTexts(provider, texts);
    if (verdict.kind === 'too_long') throw new ValidationError(TOO_LONG);
    if (verdict.kind === 'error') {
      logEvent('error', 'share_screen_failed', {
        shareId: share.id,
        trigger,
        error: verdict.message,
      });
      throw new DomainError('provider_error', UNAVAILABLE);
    }
    const audit = (data: ScreenAuditEvent['data'], holdId: string | null = null) =>
      recordAudit(env.DB, {
        kind: 'share_screened',
        actor: 'system',
        actorUserId: null,
        subjectUserId,
        shareId: share.id,
        holdId,
        data,
      });
    const { maxScores } = verdict;
    switch (verdict.kind) {
      case 'allow':
        await audit({ trigger, verdict: 'allow', maxScores });
        return;
      case 'block':
        await audit({ trigger, verdict: 'block', reasons: verdict.reasons, maxScores });
        throw new DomainError('forbidden', refused);
      case 'csam_flag': {
        let holdId: string | null = null;
        try {
          ({ holdId } = await placeHold(env.DB, {
            reason: 'csam',
            actor: 'system',
            createdBy: null,
            shareId: share.id,
            treeId: share.treeId,
            ownerAccountId: share.accountId,
            ...(payload ? { payload } : {}),
          }));
        } catch (err) {
          // Still refused and alerted: the operator places the hold by hand.
          logEvent('error', 'screen_hold_failed', { shareId: share.id, subjectUserId, error: err });
        }
        await audit({ trigger, verdict: 'csam_flag', maxScores }, holdId);
        await sendAlert(env, origin, {
          reason: 'screened_csam',
          shareId: share.id,
          subjectUserId,
          holdId,
        });
        throw new DomainError('forbidden', refused);
      }
    }
  };
}
