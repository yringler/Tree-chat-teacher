import type { Routes } from '@angular/router';
import { ChatPage } from './chat/chat-page';
import { HomePage } from './home/home-page';
import { SharesPage } from './shares/shares-page';

/**
 * `/t/:treeId` and `/t/:treeId/b/:branchId` share one ChatPage instance
 * (componentless children), so switching branches keeps the page alive.
 * Selection is read from the URL by RouteSync.
 */
export const routes: Routes = [
  { path: '', component: HomePage, title: 'Tangent' },
  {
    path: 't/:treeId',
    component: ChatPage,
    children: [
      { path: '', children: [] },
      { path: 'b/:branchId', children: [] },
    ],
  },
  { path: 'shares', component: SharesPage, title: 'Shares · Tangent' },
  { path: '**', redirectTo: '' },
];
