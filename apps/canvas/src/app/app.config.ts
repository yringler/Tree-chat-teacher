import {
  type ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';
import { provideAppPaths, provideTextSize } from '@tangent/web-shared';
import { routes } from './app.routes';

/**
 * Canvas acts as the caller's *power* account (no `x-tangent-mode` header):
 * it is another view of the same conversations the power app shows, on the
 * same bring-your-own keys.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    // `/canvas/login` is only ever reached by a full page load (see AuthService).
    provideAppPaths({ home: '/canvas/', login: '/canvas/login' }),
    // The cards' text size ("Aa"), kept apart from the other apps'.
    provideTextSize('tangent.canvas.chatFontScale'),
    provideRouter(
      routes,
      withComponentInputBinding(),
      withInMemoryScrolling({ scrollPositionRestoration: 'disabled' }),
    ),
  ],
};
