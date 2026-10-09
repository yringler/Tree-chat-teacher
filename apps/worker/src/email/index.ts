import { appConfig } from '../config.js';
import type { AppEnv } from '../env.js';
import { LogEmailSender } from './log.js';
import { ResendEmailSender } from './resend.js';
import { EmailError, type EmailSender } from './types.js';

export { magicLinkEmail } from './templates.js';
export { EmailError, type EmailMessage, type EmailSender } from './types.js';

function isLocalhost(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}

/**
 * Picks the delivery service from `EMAIL_PROVIDER` (default `resend`; an
 * unknown one fails in config.ts). This is the only provider-specific switch
 * in the app. Misconfiguration throws, so a sign-in attempt fails loudly
 * instead of silently dropping the email.
 */
export function createEmailSender(env: AppEnv, baseUrl: string): EmailSender {
  const { provider, resendApiKey: apiKey, from } = appConfig(env).email;
  switch (provider) {
    case 'resend':
      if (!apiKey || !from)
        throw new EmailError('Email is not configured (RESEND_API_KEY and EMAIL_FROM)');
      return new ResendEmailSender({ apiKey, from });
    case 'log':
      if (!isLocalhost(baseUrl))
        throw new EmailError('EMAIL_PROVIDER=log is only allowed on localhost');
      return new LogEmailSender();
  }
}
