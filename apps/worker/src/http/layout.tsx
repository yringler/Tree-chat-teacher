import type { Child, PropsWithChildren } from 'hono/jsx';
import { copyrightNotice } from './legal-info.js';
import { LEARN_COMMON_HEADERS } from './learn-app.js';

/**
 * The document every public page (landing, pricing, `/pool`, the legal
 * pages, `/verify`) is rendered into: the head, the header with the brand
 * mark, and the footer with the copyright line. Hono's JSX escapes every
 * string; the one raw insertion is the page's constant stylesheet, which the
 * response's Content-Security-Policy allows by its hash (`pageResponse`
 * derives both from the same props, so they can't drift apart).
 */

const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

/** The site's own links, as the header and footer navs name them. */
const LINKS = {
  demo: ['/learn/demo', 'Try the demo'],
  learn: ['/learn/login', 'Sign in to Learn'],
  power: ['/login', 'Power sign in'],
  about: ['/welcome', 'About Tangent'],
  pricing: ['/pricing', 'Pricing'],
  pool: ['/pool', 'Open pool'],
  privacy: ['/privacy', 'Privacy'],
  terms: ['/terms', 'Terms'],
} as const;

type LinkId = keyof typeof LINKS;

export interface PageProps {
  /** The page's path, for its canonical URL and the footer's current-page link. */
  path: string;
  /** The deployment's public origin (`LegalInfo.origin`). */
  origin: string;
  title: string;
  description?: string;
  /** Open Graph and Twitter card tags (the landing page). */
  social?: boolean;
  /** Kept out of search engines. */
  noindex?: boolean;
  /** The page's one stylesheet: a constant from page-styles.ts. */
  style: string;
  /**
   * The page holds a Turnstile widget in a form that posts back to it:
   * Cloudflare's script and iframe are loaded and a same-origin form is
   * allowed. Every other page is script-free.
   */
  turnstile?: boolean;
  /** The header's nav; none on `/verify`. */
  nav?: { label: string; links: readonly LinkId[] };
  /** The footer: the copyright line of who runs the service, then links; none on `/verify`. */
  footer?: { operator: string; links: readonly LinkId[] };
}

/** Brand mark: the app icon (the web-shared Logo) in one colour. */
export function Mark() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <circle cx="14" cy="18" r="5.5" stroke="currentColor" stroke-width="2" />
      <path
        d="M6.1 14.8L19.1 3.9"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
      />
      <circle cx="19.1" cy="3.9" r="2.4" fill="currentColor" />
    </svg>
  );
}

function Links(props: { ids: readonly LinkId[]; current?: string }) {
  return props.ids.map((id) => {
    const [href, text] = LINKS[id];
    return (
      <a href={href} aria-current={href === props.current ? 'page' : undefined}>
        {text}
      </a>
    );
  });
}

function Layout(props: PropsWithChildren<PageProps>) {
  const canonical = new URL(props.path, props.origin).toString();
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        {props.noindex && <meta name="robots" content="noindex" />}
        <title>{props.title}</title>
        {props.description && <meta name="description" content={props.description} />}
        {!props.noindex && <link rel="canonical" href={canonical} />}
        {props.social && (
          <>
            <meta property="og:type" content="website" />
            <meta property="og:site_name" content="Tangent" />
            <meta property="og:title" content={props.title} />
            <meta property="og:description" content={props.description} />
            <meta property="og:url" content={canonical} />
            <meta name="twitter:card" content="summary" />
          </>
        )}
        <style dangerouslySetInnerHTML={{ __html: props.style }} />
        {props.turnstile && <script src={`${TURNSTILE_ORIGIN}/turnstile/v0/api.js`} async defer />}
      </head>
      <body>
        <header class="wrap top">
          <a class="brand" href="/welcome">
            <Mark />
            Tangent
          </a>
          {props.nav && (
            <nav aria-label={props.nav.label}>
              <Links ids={props.nav.links} />
            </nav>
          )}
        </header>
        {props.children}
        {props.footer && (
          <footer>
            <div class="wrap">
              <span>{copyrightNotice(props.footer.operator)}</span>
              <nav aria-label="Footer">
                <Links ids={props.footer.links} current={props.path} />
              </nav>
            </div>
          </footer>
        )}
      </body>
    </html>
  );
}

/** Base64 SHA-256 of `text`: a CSP source hash. */
async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let bin = '';
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin);
}

const hashes = new Map<string, Promise<string>>();

/** `style`'s hash, memoized per stylesheet (a failure isn't kept). */
function styleHash(style: string): Promise<string> {
  let hash = hashes.get(style);
  if (!hash) {
    hash = sha256Base64(style).catch((err: unknown) => {
      hashes.delete(style);
      throw err;
    });
    hashes.set(style, hash);
  }
  return hash;
}

/**
 * The Content-Security-Policy of a public page: nothing but its one hashed
 * inline stylesheet and same-origin or data: images (the favicon), plus
 * Turnstile and a same-origin form where the page has the widget.
 */
export async function pageCsp(style: string, turnstile = false): Promise<string> {
  return [
    "default-src 'none'",
    `style-src 'sha256-${await styleHash(style)}'`,
    ...(turnstile ? [`script-src ${TURNSTILE_ORIGIN}`, `frame-src ${TURNSTILE_ORIGIN}`] : []),
    "img-src 'self' data:",
    "base-uri 'none'",
    `form-action ${turnstile ? "'self'" : "'none'"}`,
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * A public page's response: `body` in the layout, its CSP, and the headers
 * `_headers` gives the apps (they don't apply to Worker responses); `headers`
 * adds the caching.
 */
export async function pageResponse(
  page: PageProps,
  body: Child,
  init: { status?: 200 | 400; headers: Record<string, string> },
): Promise<Response> {
  const html = `<!doctype html>\n${await (<Layout {...page}>{body}</Layout>)}\n`;
  return new Response(html, {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': await pageCsp(page.style, page.turnstile),
      ...LEARN_COMMON_HEADERS,
      ...init.headers,
    },
  });
}
