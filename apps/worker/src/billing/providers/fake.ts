// A payment provider for tests (`PAYMENT_PROVIDER=fake`, only with
// TEST_SEAMS; billing/payments/index.ts). It talks to nothing:
//
// - checkout and portal URLs encode their input, `https://fake-pay.invalid/
//   <page>#<base64url JSON>`, so a test reads back what the domain asked for
//   (`decodeFakeUrl`) with no state shared between the test and the Worker;
// - a webhook is `{ "id": "<delivery id>", "events": PaymentEvent[] }`, already
//   normalised, signed by the header `fake-signature: valid` (anything else is
//   a bad signature); no events = ignored;
// - its behaviour comes from `FakeProviderOptions`, which a Worker reads from
//   the `FAKE_PAYMENTS` var (JSON) so tests can set it per request.
import type {
  DisputeEvent,
  DisputeSource,
  MembershipCheckoutInput,
  PaymentEvent,
  PaymentFacts,
  PaymentProvider,
  PortalInput,
  ProviderRef,
  RedirectSession,
  TopUpCheckoutInput,
  WebhookParseResult,
} from '../payments/port.js';
import { PaymentProviderError, WebhookSignatureError } from '../payments/port.js';

const FAKE_PAY_ORIGIN = 'https://fake-pay.invalid';
export const FAKE_SIGNATURE_HEADER = 'fake-signature';
export const FAKE_SIGNATURE = 'valid';

export interface FakeProviderOptions {
  /** What can be sold (default: both). */
  topUps?: boolean;
  membership?: boolean;
  /** The buyer has a customer at the provider, so the portal opens (default true). */
  portalCustomer?: boolean;
  /** What `deleteCustomer` does (default `absent`); `error` throws a PaymentProviderError. */
  deleteResult?: 'deleted' | 'absent' | 'error';
  /** `createTopUpCheckout` / `createMembershipCheckout` fail with a PaymentProviderError. */
  failCheckout?: boolean;
  /** The customer id checkouts report (`RedirectSession.customerRef`); none by default. */
  customerRef?: string;
  /** What `getPayment` knows, by `paymentRef`. */
  payments?: PaymentFacts[];
  /** Set = disputes are polled and every poll returns these; unset = no dispute source. */
  disputes?: DisputeEvent[];
}

/** What a fake checkout or portal URL carries. */
export type FakePage =
  | { page: 'checkout'; input: TopUpCheckoutInput }
  | { page: 'membership'; input: MembershipCheckoutInput }
  | { page: 'portal'; input: PortalInput };

function base64url(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unbase64url(encoded: string): string {
  const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

function fakeUrl(page: FakePage['page'], input: unknown): string {
  return `${FAKE_PAY_ORIGIN}/${page}#${base64url(JSON.stringify(input))}`;
}

/** The page and input a fake URL encodes; throws on anything else. */
export function decodeFakeUrl(url: string): FakePage {
  const parsed = new URL(url);
  if (parsed.origin !== FAKE_PAY_ORIGIN) throw new Error(`Not a fake payment URL: ${url}`);
  const page = parsed.pathname.slice(1);
  if (page !== 'checkout' && page !== 'membership' && page !== 'portal')
    throw new Error(`Unknown fake payment page: ${url}`);
  return { page, input: JSON.parse(unbase64url(parsed.hash.slice(1))) } as FakePage;
}

/** `FAKE_PAYMENTS` as options; empty = the defaults. */
export function parseFakeOptions(raw: string | undefined): FakeProviderOptions {
  const text = raw?.trim();
  if (!text) return {};
  return JSON.parse(text) as FakeProviderOptions;
}

export function createFakeProvider(opts: FakeProviderOptions = {}): PaymentProvider {
  const disputes: DisputeSource = opts.disputes
    ? { mode: 'poll', poll: async () => opts.disputes ?? [] }
    : { mode: 'none' };
  const session = (url: string): RedirectSession =>
    opts.customerRef ? { url, customerRef: opts.customerRef } : { url };
  const failIfAsked = () => {
    if (opts.failCheckout) throw new PaymentProviderError('Fake checkout failure', 503, true);
  };
  return {
    id: 'fake',
    capabilities: { topUps: opts.topUps ?? true, membership: opts.membership ?? true },
    disputes,
    async createTopUpCheckout(input) {
      failIfAsked();
      return session(fakeUrl('checkout', input));
    },
    async createMembershipCheckout(input) {
      failIfAsked();
      return session(fakeUrl('membership', input));
    },
    async createPortalSession(input) {
      if (opts.portalCustomer === false) return null;
      return { url: fakeUrl('portal', input) };
    },
    async deleteCustomer() {
      const result = opts.deleteResult ?? 'absent';
      if (result === 'error') throw new PaymentProviderError('Fake deletion failure', 503, true);
      return result;
    },
    async parseWebhook(req): Promise<WebhookParseResult> {
      if (req.headers.get(FAKE_SIGNATURE_HEADER) !== FAKE_SIGNATURE)
        throw new WebhookSignatureError('Bad fake signature');
      let body: { id?: unknown; events?: unknown };
      try {
        body = JSON.parse(req.rawBody) as typeof body;
      } catch {
        throw new WebhookSignatureError('Unreadable fake delivery');
      }
      const deliveryId = typeof body.id === 'string' ? body.id : null;
      const events = Array.isArray(body.events) ? (body.events as PaymentEvent[]) : [];
      if (!deliveryId || events.length === 0)
        return { kind: 'ignored', deliveryId, reason: 'no events' };
      return { kind: 'events', deliveryId, events };
    },
    async getPayment(paymentRef: ProviderRef) {
      return opts.payments?.find((p) => p.paymentRef === paymentRef) ?? null;
    },
  };
}
