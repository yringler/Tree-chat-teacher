import { InjectionToken } from '@angular/core';
import type { AccountMode } from '@tangent/shared';

/*
 * The demos: each app at its own demo URL, over an in-browser backend
 * (`@tangent/web-shared/demo`) that calls no API and no model. This file is
 * all of the demo that lives in the apps' main bundles; the backend is a
 * separate chunk each app loads only on its demo URL (its main.ts).
 */

/**
 * The three Angular apps. `power` and `simple` are also account modes; the
 * experimental `canvas` app replies as power does, so it has no mode of its
 * own (see `accountModeOf`).
 */
export type AppId = AccountMode | 'canvas';

/** The mode an app's requests generate in. */
export function accountModeOf(app: AppId): AccountMode {
  return app === 'simple' ? 'simple' : 'power';
}

/** Each app's home (its base href). */
export const APP_BASES: Readonly<Record<AppId, string>> = {
  power: '/',
  simple: '/learn/',
  canvas: '/canvas/',
};

/** Each app's demo, as its router base. The documents' `<base href>` stays the app's own (assets). */
export const DEMO_BASES: Readonly<Record<AppId, string>> = {
  power: '/demo/',
  simple: '/learn/demo/',
  canvas: '/canvas/demo/',
};

/**
 * A conversation's address in the app at `base`: `t/<treeId>[/b/<branchId>]`
 * under it, or the app's home when no conversation is open. Every app routes
 * that path, so one conversation opens in any of them.
 */
export function conversationHref(
  base: string,
  treeId: string | null,
  branchId: string | null = null,
): string {
  if (treeId === null) return base;
  const tree = `${base}t/${encodeURIComponent(treeId)}`;
  return branchId === null ? tree : `${tree}/b/${encodeURIComponent(branchId)}`;
}

/** True for `base` itself and everything under it, with or without the trailing slash. */
export function isDemoPath(pathname: string, app: AppId): boolean {
  const base = DEMO_BASES[app];
  return pathname === base.slice(0, -1) || pathname.startsWith(base);
}

/** True when the app runs as its demo (provided by `demoProviders`). */
export const DEMO_MODE = new InjectionToken<boolean>('DEMO_MODE', {
  providedIn: 'root',
  factory: () => false,
});
