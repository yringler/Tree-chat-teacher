import { authBaseUrl } from '../auth/auth.js';
import { appConfig } from '../config.js';
import type { AppEnv } from '../env.js';
import { sharingMode } from '../availability.js';

/**
 * Who runs this deployment and how to reach them, from the LEGAL_* vars: used by the legal pages (http/legal.tsx) and the copyright
 * line in every page footer.
 */

/** The operator details the documents are written for. */
export interface LegalInfo {
  /** Legal name of the person or company running the service. */
  operator: string;
  /** Mailbox for privacy requests, legal notices and copyright complaints. */
  contactEmail: string;
  /** Governing law and courts, e.g. "the State of New York, USA"; empty = where the operator is established. */
  jurisdiction: string;
  /** Public origin, e.g. https://tangentailearning.com. */
  origin: string;
  /**
   * Share links are offered to everyone (`SHARING` is `everyone`). False: the
   * pages say links exist only where the operator enables them, and point to export.
   */
  sharing: boolean;
  /**
   * Share links are screened by the moderation provider before they are
   * published (`MODERATION_API_KEY` is set), so it is listed as a recipient.
   */
  screening: boolean;
}

export function legalInfo(env: AppEnv, request: Request): LegalInfo {
  const origin = authBaseUrl(env, request);
  const legal = appConfig(env).site.legal;
  return {
    operator: legal.operator ?? `the operator of ${new URL(origin).host}`,
    contactEmail: legalContactEmail(env, origin),
    jurisdiction: legal.jurisdiction,
    origin,
    sharing: sharingMode(env) === 'everyone',
    screening: appConfig(env).site.moderationApiKey !== null,
  };
}

/** `LEGAL_CONTACT_EMAIL`, or privacy@ the public origin's host. */
export function legalContactEmail(env: AppEnv, origin: string): string {
  return appConfig(env).site.legal.contactEmail ?? `privacy@${new URL(origin).hostname}`;
}

/** Copyright and trademark line, shared by every footer that links the legal pages. */
export function copyrightNotice(operator: string, year = new Date().getUTCFullYear()): string {
  return `© ${year} ${operator}. Tangent and the Tangent logo are trademarks of ${operator}.`;
}
