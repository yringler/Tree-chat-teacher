import { type ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withInMemoryScrolling } from '@angular/router';
import { provideAppPaths } from '@tangent/web-shared';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // `/login` is only ever reached by a full page load (see AuthService).
    provideAppPaths({ home: '/', login: '/login' }),
    provideRouter(routes, withInMemoryScrolling({ scrollPositionRestoration: 'disabled' })),
  ],
};
