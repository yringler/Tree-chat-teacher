import { ChangeDetectionStrategy, Component, inject, Injectable, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Icon } from './icon';

/**
 * A link in a toast: `path` is a route of this app (e.g. power's
 * `/billing`), `href` a full page load (e.g. the canvas sending to power's).
 */
export type ToastLink = { label: string; path: string } | { label: string; href: string };

export interface Toast {
  id: number;
  kind: 'info' | 'error';
  text: string;
  link?: ToastLink;
}

/** How many toasts show at once: a new one pushes out the oldest. */
const MAX_TOASTS = 3;

/** The app's toasts: short notices that dismiss themselves (an error stays longer). */
@Injectable({ providedIn: 'root' })
export class ToastStore {
  readonly toasts = signal<readonly Toast[]>([]);
  private seq = 0;

  notify(text: string, kind: Toast['kind'] = 'info', link?: ToastLink): void {
    const id = ++this.seq;
    this.toasts.update((list) => [
      ...list.slice(1 - MAX_TOASTS),
      { id, kind, text, ...(link ? { link } : {}) },
    ]);
    setTimeout(() => this.dismiss(id), kind === 'error' ? 8000 : 3500);
  }

  dismiss(id: number): void {
    this.toasts.update((list) => list.filter((t) => t.id !== id));
  }
}

/** Renders `ToastStore`'s toasts at the foot of the page. Styles: `.toasts` in base.css. */
@Component({
  selector: 'app-toasts',
  imports: [Icon, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'toasts', role: 'status', 'aria-live': 'polite' },
  template: `
    @for (t of store.toasts(); track t.id) {
      <div class="toast" [class.toast-error]="t.kind === 'error'">
        <span
          >{{ t.text }}
          @if (t.link; as link) {
            @if (pathOf(link); as path) {
              <a class="toast-link" [routerLink]="path" (click)="store.dismiss(t.id)">{{
                link.label
              }}</a>
            } @else {
              <a class="toast-link" [href]="hrefOf(link)">{{ link.label }}</a>
            }
          }
        </span>
        <button type="button" class="icon-btn" aria-label="Dismiss" (click)="store.dismiss(t.id)">
          <app-icon name="x" [size]="14" />
        </button>
      </div>
    }
  `,
})
export class Toasts {
  protected readonly store = inject(ToastStore);

  protected pathOf(link: ToastLink): string | null {
    return 'path' in link ? link.path : null;
  }

  protected hrefOf(link: ToastLink): string | null {
    return 'href' in link ? link.href : null;
  }
}
