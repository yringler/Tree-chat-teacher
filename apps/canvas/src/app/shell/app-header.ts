import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Logo, ModeSwitch, SidebarToggle } from '@tangent/web-shared';
import { BRAND, BRAND_SHORT } from '../brand';
import { CanvasStore } from '../state/canvas-store';

/**
 * The sidebar's button (narrow screens), brand, the Power / Learn / Canvas
 * switch and the experimental mark. Keys and the account are in the sidebar.
 */
@Component({
  selector: 'app-header',
  imports: [RouterLink, Logo, ModeSwitch, SidebarToggle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="app-head">
      <app-sidebar-toggle />
      <a routerLink="/" class="brand" [attr.aria-label]="brand">
        <app-logo [size]="22" />
        <span aria-hidden="true"
          >{{ brandShort }}<span class="hide-narrow">{{ brandRest }}</span></span
        >
      </a>
      <app-mode-switch
        current="canvas"
        [treeId]="store.selectedTreeId()"
        [branchId]="store.selectedBranchId()"
      />
      <span
        class="badge badge-experimental"
        title="Canvas is experimental: the same conversations and keys as Power mode, a very different way of looking at them"
        >experimental</span
      >
      @if (store.account.me()?.devMode) {
        <span class="badge badge-warn" title="DEV_ALLOW_NO_AUTH is on">dev: auth disabled</span>
      }
    </header>
  `,
})
export class AppHeader {
  protected readonly store = inject(CanvasStore);
  protected readonly brand = BRAND;
  protected readonly brandShort = BRAND_SHORT;
  protected readonly brandRest = BRAND.startsWith(BRAND_SHORT)
    ? BRAND.slice(BRAND_SHORT.length)
    : '';
}
