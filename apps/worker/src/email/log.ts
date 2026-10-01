import type { EmailMessage, EmailSender } from './types.js';

/**
 * Local development only: prints the message (including any sign-in link) to
 * the `wrangler dev` console instead of sending it. `createEmailSender`
 * refuses it for non-localhost deployments, since a logged magic link is a
 * usable credential for anyone who can read the logs.
 */
export class LogEmailSender implements EmailSender {
  send(message: EmailMessage): Promise<void> {
    console.log(
      `[email] to=${message.to} subject=${JSON.stringify(message.subject)}\n${message.text}`,
    );
    return Promise.resolve();
  }
}
