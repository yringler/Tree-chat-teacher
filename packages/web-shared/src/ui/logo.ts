import { ChangeDetectionStrategy, Component, input } from '@angular/core';

let nextId = 0;

/**
 * The Tangent logo: the app icon (apps/web/public/favicon.svg; keep them in
 * sync) drawn inline. Decorative: pair with the brand name or an aria-label.
 * Gradient ids are per instance so two logos on one page never resolve
 * url(#…) into each other's (possibly hidden) defs.
 */
@Component({
  selector: 'app-logo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<svg
    viewBox="0 0 512 512"
    [attr.width]="size()"
    [attr.height]="size()"
    aria-hidden="true"
    focusable="false"
  >
    <defs>
      <linearGradient [attr.id]="orb" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#4f8dff" />
        <stop offset="1" stop-color="#8b4dff" />
      </linearGradient>
      <linearGradient
        [attr.id]="ray"
        gradientUnits="userSpaceOnUse"
        x1="104"
        y1="320"
        x2="368"
        y2="99"
      >
        <stop offset="0" stop-color="#ff4f9a" />
        <stop offset=".65" stop-color="#ff8a3d" />
        <stop offset="1" stop-color="#ffd23f" />
      </linearGradient>
    </defs>
    <rect width="512" height="512" rx="116" fill="#141033" />
    <circle cx="304" cy="326" r="118" [attr.fill]="'url(#' + orb + ')'" />
    <path
      d="M102.9 319.7L371 94.7"
      [attr.stroke]="'url(#' + ray + ')'"
      stroke-width="32"
      stroke-linecap="round"
    />
    <circle cx="371" cy="94.7" r="31" fill="#ffd23f" />
  </svg>`,
  host: { class: 'logo' },
})
export class Logo {
  readonly size = input(20);
  private readonly uid = nextId++;
  protected readonly orb = `logo-orb-${this.uid}`;
  protected readonly ray = `logo-ray-${this.uid}`;
}
