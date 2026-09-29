import { DestroyRef, inject, Injectable } from '@angular/core';
import { type ActivatedRouteSnapshot, NavigationEnd, Router } from '@angular/router';
import { TreeStore } from '../state/tree-store';

/** Pushes `/t/:treeId[/b/:branchId]?m=<nodeId>` into the TreeStore after every navigation. */
@Injectable({ providedIn: 'root' })
export class RouteSync {
  private readonly router = inject(Router);
  private readonly store = inject(TreeStore);

  start(destroyRef: DestroyRef): void {
    const sub = this.router.events.subscribe((e) => {
      if (e instanceof NavigationEnd) this.sync();
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
