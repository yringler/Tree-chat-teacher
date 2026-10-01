import { EmailError, type EmailMessage, type EmailSender } from './types.js';

export interface ResendOptions {
  apiKey: string;
  /** Verified sender, e.g. `Tangent <login@example.com>`. */
  from: string;
  /** Test hook. */
  fetch?: typeof fetch;
  /** Test hook; defaults to Resend's API. */
  baseUrl?: string;
}

/**
 * Resend over its REST API (https://resend.com/docs/api-reference/emails/send-email).
 * Raw `fetch` instead of the SDK, like the LLM providers: no dependency and
 * nothing Node-specific.
 */
export class ResendEmailSender implements EmailSender {
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: ResendOptions) {
    // Bound: calling an unbound global fetch through a property throws "Illegal invocation" in workerd.
    this.fetchFn = options.fetch ?? fetch.bind(globalThis);
    this.baseUrl = (options.baseUrl ?? 'https://api.resend.com').replace(/\/+$/, '');
  }

  async send(message: EmailMessage): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/emails`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: this.options.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
      });
    } catch (err) {
      throw new EmailError(
        `Resend unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      // Resend's error body is `{ name, message, statusCode }`; it never echoes the API key.
      let detail = '';
      try {
        const body: unknown = await res.json();
        if (
          typeof body === 'object' &&
          body !== null &&
          'message' in body &&
          typeof body.message === 'string'
        ) {
          detail = `: ${body.message}`;
        }
      } catch {
        // Not JSON.
      }
      throw new EmailError(`Resend rejected the message (${res.status})${detail}`, res.status);
    }
  }
}
