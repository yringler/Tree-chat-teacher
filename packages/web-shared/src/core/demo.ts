import { InjectionToken } from '@angular/core';
import type { AccountMode } from '@tangent/shared';

/*
 * The demos: each app at its own demo URL, over an in-browser backend
 * (`@tangent/web-shared/demo`) that calls no API and no model. This file is
 * all of the demo that lives in the apps' main bundles; the backend is a
 * separate chunk each app loads only on its demo URL (its main.ts).
 */

/** Each app's demo, as its router base. The documents' `<base href>` stays the app's own (assets). */
export const DEMO_BASES: Readonly<Record<AccountMode, string>> = {
  power: '/demo/',
  simple: '/learn/demo/',
};

/** True for `base` itself and everything under it, with or without the trailing slash. */
export function isDemoPath(pathname: string, mode: AccountMode): boolean {
  const base = DEMO_BASES[mode];
  return pathname === base.slice(0, -1) || pathname.startsWith(base);
}

/** True when the app runs as its demo (provided by `demoProviders`). */
export const DEMO_MODE = new InjectionToken<boolean>('DEMO_MODE', {
  providedIn: 'root',
  factory: () => false,
});
