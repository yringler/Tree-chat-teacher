/*
 * Spec helpers for the Angular packages (`@tangent/web-shared/testing`):
 * fixtures, the TestBed render helper and what an app's components need
 * around them. Only specs import this, so it never reaches an app bundle.
 */
export * from './fixtures';
export { appProviders, me, openTree, powerProviders, signIn } from './power';
export { provideAnyRoute, render, type Rendered } from './render';
