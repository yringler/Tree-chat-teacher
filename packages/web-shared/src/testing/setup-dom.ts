import '@angular/compiler'; // JIT: TestBed compiles the components each spec renders.
import { getTestBed, TestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { afterEach } from 'vitest';

getTestBed().initTestEnvironment(BrowserTestingModule, platformBrowserTesting(), {
  teardown: { destroyAfterEach: true },
});

// The apps' pages have a doctype; happy-dom has no `compatMode`, which KaTeX reads as quirks mode.
Object.defineProperty(document, 'compatMode', { value: 'CSS1Compat' });

// Component tests never reach a server: a request a spec didn't stub fails loudly.
globalThis.fetch = (input) =>
  Promise.reject(new Error(`No network in component tests: ${String(input)}`));

afterEach(() => {
  TestBed.resetTestingModule();
  document.body.innerHTML = '';
  localStorage.clear();
});
