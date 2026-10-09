import { ChangeDetectionStrategy, Component } from '@angular/core';
import { BillingPage, SidebarToggle } from '@tangent/web-shared';

/**
 * `/billing`: the shared billing page (membership, Tangent credit, usage).
 * A wrapper rather than route data, because the power app's router doesn't
 * bind inputs (that would reset the login page's inputs); BillingPage reads
 * `?checkout=` from the route itself. On narrow screens it adds the menu
 * button the other pages have in their header.
 */
@Component({
  selector: 'app-billing-route',
  imports: [BillingPage, SidebarToggle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="page-head only-narrow">
      <app-sidebar-toggle />
    </header>
    <app-billing-page homePath="/" homeLabel="Conversations" billingPath="/billing" />
  `,
  host: { class: 'page' },
})
export class BillingRoute {}
