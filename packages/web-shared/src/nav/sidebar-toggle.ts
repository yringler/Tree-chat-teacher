import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Icon } from '../ui/icon';
import { SidebarState } from './sidebar-host';

/**
 * The page header's sidebar button (`#sidebar`). Narrow screens: opens the
 * drawer. Wide screens: hides or shows the sidebar, so a large tree (the
 * canvas above all) can have the whole width.
 */
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
    @let label = sidebar.hidden() ? 'Show sidebar' : 'Hide sidebar';
    <button
      type="button"
      class="icon-btn only-wide"
      [attr.aria-label]="label"
      [title]="label"
      aria-controls="sidebar"
      [attr.aria-expanded]="!sidebar.hidden()"
      (click)="sidebar.toggleHidden()"
    >
      <app-icon name="panelLeft" />
    </button>
  `,
  host: { style: 'display: contents' },
})
export class SidebarToggle {
  protected readonly sidebar = inject(SidebarState);
}
