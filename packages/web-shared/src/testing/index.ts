/*
 * Spec helpers for the Angular packages (`@tangent/web-shared/testing`):
 * fixtures and the TestBed render helper. Only specs import this, so it
 * never reaches an app bundle.
 */
export * from './fixtures';
export { render, type Rendered } from './render';
