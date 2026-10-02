import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { BillingPage, Icon } from '@tangent/web-shared';
import { UiStore } from '../state/ui-store';

/**
 * `/billing`: the shared billing page (membership, Tangent credit, usage).
 * A wrapper rather than route data, because the power app's router doesn't
 * bind inputs (that would reset the login page's inputs); BillingPage reads
 * `?checkout=` from the route itself. On narrow screens it adds the menu
 * button the other pages have in their header.
 */
@Component({
  selector: 'app-billing-route',
  imports: [BillingPage, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="page-head only-narrow">
      <button
        type="button"
        class="icon-btn"
        aria-label="Open menu"
        aria-controls="sidebar"
        [attr.aria-expanded]="ui.drawerOpen()"
        (click)="ui.drawerOpen.set(true)"
      >
        <app-icon name="menu" />
      </button>
    </header>
    <app-billing-page homePath="/" homeLabel="Conversations" billingPath="/billing" />
  `,
  host: { class: 'page' },
})
export class BillingRoute {
  protected readonly ui = inject(UiStore);
}
