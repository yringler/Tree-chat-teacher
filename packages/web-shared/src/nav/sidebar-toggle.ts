import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Icon } from '../ui/icon';
import { SidebarState } from './sidebar-host';

/** Narrow screens: the page header's button that opens the sidebar's drawer (`#sidebar`). */
@Component({
  selector: 'app-sidebar-toggle',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="icon-btn only-narrow"
      aria-label="Open menu"
      aria-controls="sidebar"
      [attr.aria-expanded]="sidebar.drawerOpen()"
      (click)="sidebar.drawerOpen.set(true)"
    >
      <app-icon name="menu" />
    </button>
  `,
  host: { style: 'display: contents' },
})
export class SidebarToggle {
  protected readonly sidebar = inject(SidebarState);
}
