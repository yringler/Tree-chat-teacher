import type { Routes } from '@angular/router';

/** Routes are relative to the base href `/learn/` (wave 3: `simple-app`). */
export const routes: Routes = [{ path: '**', redirectTo: '' }];
