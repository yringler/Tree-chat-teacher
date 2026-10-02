import { InjectionToken } from '@angular/core';

/*
 * The Tangent Learn demo: the same app at `/learn/demo/`, over an in-browser
 * backend (see demo-backend.ts) that calls no API and no model. This file
 * is all of the demo that lives in the main bundle; the rest is loaded only
 * on demo URLs (main.ts).
 */

/** Router base of the demo; the document's `<base href>` stays `/learn/` for assets. */
export const DEMO_BASE = '/learn/demo/';
/** Where the banner's "Start learning for real" goes (the real sign-in page). */
export const DEMO_SIGNUP_URL = '/learn/login';
/** Where "Sign out" goes in the demo (the public landing page). */
export const DEMO_EXIT_URL = '/welcome';

export function isDemoPath(pathname: string): boolean {
  return pathname === '/learn/demo' || pathname.startsWith(DEMO_BASE);
}

/** True when the app runs as the demo (provided by demo-providers.ts). */
export const DEMO_MODE = new InjectionToken<boolean>('DEMO_MODE', {
  providedIn: 'root',
  factory: () => false,
});
