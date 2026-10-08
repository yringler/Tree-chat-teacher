import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Stroke icons (24×24 viewBox, currentColor). Decorative: pair with a text label or aria-label. */
const PATHS = {
  menu: 'M4 6h16M4 12h16M4 18h16',
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6L6 18',
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  chevronUp: 'M6 15l6-6 6 6',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',
  signOut: 'M9 4H5v16h4M16 8l4 4-4 4M20 12H9',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  key: 'M14.5 9.5a4 4 0 1 0-4 4M10.5 13.5L4 20M6 18l2 2M8 16l2 2',
  branch:
    'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  settings: 'M4 7h10M18 7h2M4 17h4M12 17h8M14 4v6M8 14v6',
  share: 'M4 12v8h16v-8M12 3v13M7 8l5-5 5 5',
  download: 'M12 3v12M7 10l5 5 5-5M4 21h16',
  upload: 'M12 21V9M7 14l5-5 5 5M4 3h16',
  panel: 'M3 4h18v16H3zM15 4v16',
  help: 'M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.5',
  stop: 'M7 7h10v10H7z',
  send: 'M5 12h14M13 6l6 6-6 6',
  back: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  review: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM8.5 12.5l2.5 2.5 4.5-5',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.5 15.5L20 20',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  compare: 'M3 4h7v16H3zM14 4h7v16h-7z',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1',
} as const;

export type IconName = keyof typeof PATHS;

@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<svg
    viewBox="0 0 24 24"
    [attr.width]="size()"
    [attr.height]="size()"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path [attr.d]="d()" />
  </svg>`,
  host: { class: 'icon' },
})
export class Icon {
  readonly name = input.required<IconName>();
  readonly size = input(16);
  protected readonly d = computed(() => PATHS[this.name()]);
}
