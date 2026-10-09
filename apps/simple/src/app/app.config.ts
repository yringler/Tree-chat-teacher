import {
  type ApplicationConfig,
  inject,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';
import type { BillingSummary } from '@tangent/shared';
import {
  API_HEADERS,
  BILLING_SUMMARY_LISTENER,
  provideAppPaths,
  provideTextSize,
} from '@tangent/web-shared';
import { routes } from './app.routes';
import { PaymentChoice } from './state/payment-choice';
import { LearnFunding } from './state/learn-funding';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    // `/learn/login` is only ever reached by a full page load (see AuthService).
    provideAppPaths({ home: '/learn/', login: '/learn/login' }),
    // The lesson's text size ("Aa"), kept apart from the other apps'.
    provideTextSize('tangent.learn.chatFontScale'),
    // Every API call is in Learn mode, paying as they chose.
    {
      provide: API_HEADERS,
      useFactory: () => {
        const choice = inject(PaymentChoice);
        return () => choice.headers();
      },
    },
    // The billing page's summaries keep the header pill and the locked-key notice current.
    {
      provide: BILLING_SUMMARY_LISTENER,
      useFactory: () => {
        const funding = inject(LearnFunding);
        return (summary: BillingSummary) => funding.applyBilling(summary);
      },
    },
    provideRouter(
      routes,
      withComponentInputBinding(),
      withInMemoryScrolling({ scrollPositionRestoration: 'disabled' }),
    ),
  ],
};
