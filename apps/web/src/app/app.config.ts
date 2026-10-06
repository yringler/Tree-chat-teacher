import { type ApplicationConfig, inject, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withInMemoryScrolling } from '@angular/router';
import type { BillingSummary } from '@tangent/shared';
import { BILLING_SUMMARY_LISTENER, provideAppPaths, provideTextSize } from '@tangent/web-shared';
import { routes } from './app.routes';
import { TreeStore } from './state/tree-store';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // `/login` is only ever reached by a full page load (see AuthService).
    provideAppPaths({ home: '/', login: '/login' }),
    // The conversation's text size ("Aa"), kept under the key it always had.
    provideTextSize('tangent.chatFontScale'),
    // The billing page's summaries keep the keys dialog's balance and the membership gate current.
    {
      provide: BILLING_SUMMARY_LISTENER,
      useFactory: () => {
        const store = inject(TreeStore);
        return (summary: BillingSummary) => store.applyBilling(summary);
      },
    },
    provideRouter(routes, withInMemoryScrolling({ scrollPositionRestoration: 'disabled' })),
  ],
};
