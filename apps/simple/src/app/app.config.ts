import {
  type ApplicationConfig,
  inject,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';
import { API_HEADERS, provideAppPaths } from '@tangent/web-shared';
import { routes } from './app.routes';
import { PaymentStore } from './state/payment-store';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    // `/learn/login` is only ever reached by a full page load (see AuthService).
    provideAppPaths({ home: '/learn/', login: '/learn/login' }),
    // Every API call acts as the learner's Learn account, paying as they chose.
    {
      provide: API_HEADERS,
      useFactory: () => {
        const payment = inject(PaymentStore);
        return () => payment.headers();
      },
    },
    provideRouter(
      routes,
      withComponentInputBinding(),
      withInMemoryScrolling({ scrollPositionRestoration: 'disabled' }),
    ),
  ],
};
