import { InjectionToken, type Provider } from '@angular/core';

/**
 * Where an app lives on the shared origin. The power app is served at `/`
 * (`{ home: '/', login: '/login' }`); the simple app at `/learn/`
 * (`{ home: '/learn/', login: '/learn/login' }`). AuthService uses these for
 * redirects and for the sign-in callback URLs. Both are absolute paths.
 */
export interface AppPaths {
  /** The app's start page, where a completed sign-in lands. */
  home: string;
  /** The app's login page (always reached by a full page load). */
  login: string;
}

/** Required: there's no default, so each app states where it lives. */
export const APP_PATHS = new InjectionToken<AppPaths>('APP_PATHS');

export function provideAppPaths(paths: AppPaths): Provider {
  return { provide: APP_PATHS, useValue: paths };
}
