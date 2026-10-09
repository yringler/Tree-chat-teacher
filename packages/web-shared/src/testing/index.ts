/*
 * Spec helpers for the Angular packages (`@tangent/web-shared/testing`):
 * fixtures, the TestBed render helper and a signed-in power store. Only specs import this, so it
 * never reaches an app bundle.
 */
export * from './fixtures';
export { me, openTree, powerProviders, signIn } from './power';
export { provideAnyRoute, render, type Rendered } from './render';
