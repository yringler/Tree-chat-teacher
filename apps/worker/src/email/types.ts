/**
 * Outgoing email, independent of the delivery service. Everything that sends
 * mail depends on `EmailSender` only; `createEmailSender` (index.ts) is the
 * one place that picks an implementation, so switching providers means
 * adding a class and a case there.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text body. Always sent, for clients that don't render HTML. */
  text: string;
  html: string;
}

export interface EmailSender {
  /** Resolves once the provider accepted the message. Throws EmailError otherwise. */
  send(message: EmailMessage): Promise<void>;
}

export class EmailError extends Error {
  constructor(
    message: string,
    /** Provider HTTP status, when the failure came from the provider's API. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'EmailError';
  }
}
