import type { Routes } from '@angular/router';
import { LoginPage } from '@tangent/web-shared';
import { BRAND } from './brand';
import { CanvasPage } from './canvas/canvas-page';
import { HomePage } from './home/home-page';

/**
 * Routes are relative to the base href `/canvas/`.
 *
 * `t/:treeId` and `t/:treeId/b/:branchId` share one CanvasPage instance
 * (componentless children), so selecting a lane keeps the canvas alive;
 * RouteSync reads the selection from the URL.
 */
export const routes: Routes = [
  { path: '', component: HomePage, title: BRAND },
  {
    path: 'login',
    component: LoginPage,
    title: `Sign in · ${BRAND}`,
    data: {
      brand: BRAND,
      lead: 'Sign in to open your conversations on the canvas',
    },
  },
  {
    path: 't/:treeId',
    component: CanvasPage,
    children: [
      { path: '', children: [] },
      { path: 'b/:branchId', children: [] },
    ],
  },
  { path: '**', redirectTo: '' },
];
