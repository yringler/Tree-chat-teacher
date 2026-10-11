// Alerts: email to the operator's legal contact when something needs a person
// at once (possible child sexual abuse material, a threat of violence). They
// carry the reason, ids and a link to the admin page, never a conversation's
// content, so a mailbox or a log never holds the material itself.
import { alertEmail, createEmailSender } from './email/index.js';
import type { AppEnv } from './env.js';
import { legalContactEmail } from './http/legal-info.js';
import { logEvent } from './log.js';

/** Why an alert was sent. */
export type AlertReason = 'screened_csam';

export interface Alert {
  reason: AlertReason;
  shareId: string | null;
  /** The share's owner. */
  subjectUserId: string | null;
  holdId?: string | null;
  reportId?: string | null;
}

const TEXT: Record<AlertReason, { title: string; summary: string }> = {
  screened_csam: {
    title: 'possible CSAM refused at publishing',
    summary:
      'Screening flagged a conversation as possible child sexual abuse material when its owner tried to publish it. ' +
      'Publishing was refused without saying why, and the conversation is on legal hold. ' +
      'Follow the CSAM runbook (docs/runbooks/csam.md).',
  },
};

/**
 * Emails `alert` to the legal contact (`LEGAL_CONTACT_EMAIL`) with the
 * deployment's email sender. Best-effort: the action that raised it has
 * already happened, so a failure is logged (`alert_failed`) and never thrown.
 * `origin` is the deployment's public origin, for the admin link.
 */
export async function sendAlert(env: AppEnv, origin: string, alert: Alert): Promise<void> {
  const ids = {
    reason: alert.reason,
    shareId: alert.shareId,
    subjectUserId: alert.subjectUserId,
    holdId: alert.holdId ?? null,
    reportId: alert.reportId ?? null,
  };
  try {
    const facts = Object.entries({
      Share: alert.shareId,
      'Owner (user id)': alert.subjectUserId,
      'Legal hold': alert.holdId,
      Report: alert.reportId,
    }).flatMap(([label, id]) => (id ? [[label, id] as const] : []));
    const message = alertEmail(
      legalContactEmail(env, origin),
      { ...TEXT[alert.reason], facts },
      new URL('/admin/', origin).toString(),
    );
    await createEmailSender(env, origin).send(message);
    logEvent('warn', 'alert_sent', ids);
  } catch (err) {
    logEvent('error', 'alert_failed', { ...ids, error: err });
  }
}
