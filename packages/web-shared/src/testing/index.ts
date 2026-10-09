/*
 * Spec helpers for the Angular packages (`@tangent/web-shared/testing`):
 * fixtures and the TestBed render helper. Only specs import this, so it
 * never reaches an app bundle.
 */
export * from './fixtures';
export { provideAnyRoute, render, type Rendered } from './render';
