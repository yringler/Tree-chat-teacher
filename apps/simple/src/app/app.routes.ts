import type { Routes } from '@angular/router';
import { BillingPage, LoginPage } from '@tangent/web-shared';
import { BRAND } from './brand';
import { ChatPage } from './chat/chat-page';
import { HomePage } from './home/home-page';

/**
 * Routes are relative to the base href `/learn/`.
 *
 * `t/:treeId` and `t/:treeId/b/:branchId` share one ChatPage instance
 * (componentless children), so switching branches keeps the page alive;
 * RouteSync reads the selection from the URL.
 *
 * `login` is only ever reached by a full page load (see AuthService); its
 * copy comes from route data through `withComponentInputBinding()`, as do
 * the shared billing page's home link and its path.
 */
export const routes: Routes = [
  { path: '', component: HomePage, title: BRAND },
  {
    path: 'login',
    component: LoginPage,
    title: `Sign in · ${BRAND}`,
    data: {
      brand: BRAND,
      lead: 'Sign in or create an account to start learning',
    },
  },
  {
    path: 't/:treeId',
    component: ChatPage,
    children: [
      { path: '', children: [] },
      { path: 'b/:branchId', children: [] },
    ],
  },
  {
    path: 'billing',
    component: BillingPage,
    title: `Billing · ${BRAND}`,
    data: { homePath: '/', homeLabel: 'Lessons', billingPath: '/learn/billing' },
  },
  { path: '**', redirectTo: '' },
];
