import { authBaseUrl } from '../auth/auth.js';
import type { AppEnv } from '../env.js';

/**
 * Who runs this deployment and how to reach them, from the LEGAL_* vars in
 * wrangler.jsonc: used by the legal pages (http/legal.ts) and the copyright
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
}

export function legalInfo(env: AppEnv, request: Request): LegalInfo {
  const origin = authBaseUrl(env, request);
  return {
    operator: env.LEGAL_OPERATOR?.trim() || `the operator of ${new URL(origin).host}`,
    contactEmail: env.LEGAL_CONTACT_EMAIL?.trim() || `privacy@${new URL(origin).hostname}`,
    jurisdiction: env.LEGAL_JURISDICTION?.trim() ?? '',
    origin,
  };
}

/** Copyright and trademark line, shared by every footer that links the legal pages. */
export function copyrightNotice(operator: string, year = new Date().getUTCFullYear()): string {
  return `© ${year} ${operator}. Tangent and the Tangent logo are trademarks of ${operator}.`;
}
