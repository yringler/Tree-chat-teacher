import {
  type ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideAppPaths } from '@tangent/web-shared';

/**
 * The admin app acts as the caller's power account (no `x-tangent-mode`
 * header) and only calls `/api/me` and `/api/admin/*`. It has no login page
 * of its own: an expired session goes to the power app's.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideAppPaths({ home: '/admin/', login: '/login' }),
  ],
};
