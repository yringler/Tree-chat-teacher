import type { Routes } from '@angular/router';
import { ChatPage } from './chat/chat-page';
import { HomePage } from './home/home-page';
import { LoginPage } from '@tangent/web-shared';
import { SharesPage } from './shares/shares-page';

/**
 * `/t/:treeId` and `/t/:treeId/b/:branchId` share one ChatPage instance
 * (componentless children), so switching branches keeps the page alive.
 * Selection is read from the URL by RouteSync.
 *
 * `/login` is only ever reached by a full page load (see AuthService).
 * `/billing` is where the checkout sends the browser back (`?checkout=`); the
 * Worker's SPA fallback serves it on a full page load.
 */
export const routes: Routes = [
  { path: '', component: HomePage, title: 'Tangent' },
  { path: 'login', component: LoginPage, title: 'Sign in · Tangent' },
  {
    path: 't/:treeId',
    component: ChatPage,
    children: [
      { path: '', children: [] },
      { path: 'b/:branchId', children: [] },
    ],
  },
  { path: 'shares', component: SharesPage, title: 'Shares · Tangent' },
  {
    path: 'billing',
    title: 'Billing · Tangent',
    loadComponent: () => import('./billing/billing-route').then((m) => m.BillingRoute),
  },
  { path: '**', redirectTo: '' },
];
