import { DestroyRef, inject, Injectable } from '@angular/core';
import { type ActivatedRouteSnapshot, NavigationEnd, Router } from '@angular/router';
import { AccountStore } from '../state/account-store';
import { LessonStore } from '../state/lesson-store';

/**
 * Pushes `/t/:treeId[/b/:branchId]?m=<nodeId>` into the LessonStore after
 * every navigation, and re-reads the balance after leaving the billing page
 * (a top-up or plan change happened there).
 */
@Injectable({ providedIn: 'root' })
export class RouteSync {
  private readonly router = inject(Router);
  private readonly store = inject(LessonStore);
  private readonly account = inject(AccountStore);
  private lastUrl = '';

  start(destroyRef: DestroyRef): void {
    const sub = this.router.events.subscribe((e) => {
      if (!(e instanceof NavigationEnd)) return;
      this.sync();
      const wasBilling = this.lastUrl.startsWith('/billing');
      this.lastUrl = e.urlAfterRedirects;
      if (wasBilling && !this.lastUrl.startsWith('/billing')) void this.account.refreshBalance();
    });
    destroyRef.onDestroy(() => sub.unsubscribe());
  }

  private sync(): void {
    let snap: ActivatedRouteSnapshot | null = this.router.routerState.snapshot.root;
    let treeId: string | null = null;
    let branchId: string | null = null;
    while (snap) {
      treeId = snap.paramMap.get('treeId') ?? treeId;
      branchId = snap.paramMap.get('branchId') ?? branchId;
      snap = snap.firstChild;
    }
    const m = this.router.routerState.snapshot.root.queryParamMap.get('m');
    this.store.setRoute(treeId, branchId, m);
  }
}
