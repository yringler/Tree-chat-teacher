import { InjectionToken } from '@angular/core';

/** Loads another document of the origin (another app, e.g. a lesson in Learn). */
export type LeavePage = (href: string) => void;

/**
 * How the apps open a page of another app: a full page load, since each app
 * is its own document (`location.assign`). A token so tests, which have no
 * DOM, can see where the browser would go.
 */
export const LEAVE_PAGE = new InjectionToken<LeavePage>('LEAVE_PAGE', {
  providedIn: 'root',
  factory: () => (href: string) => location.assign(href),
});
