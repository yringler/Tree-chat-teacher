import '@angular/compiler'; // JIT: the component metadata below.
import { NgModule, platformCore } from '@angular/core';
import { TestBed, TestComponentRenderer } from '@angular/core/testing';
import { BrowserModule } from '@angular/platform-browser';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ExpiryPicker } from './expiry-picker';

/** Change detection without a DOM: the picker is created by hand, nothing renders. */
const NoDom = NgModule({
  imports: [BrowserModule],
  providers: [{ provide: TestComponentRenderer }],
})(class {});

/** The picker as the share editor opens it on `expiresAt`, change detection run once. */
function open(expiresAt: string | null): ExpiryPicker {
  const p = TestBed.runInInjectionContext(() => new ExpiryPicker());
  p.expiresAt.set(expiresAt);
  p.ngOnInit();
  TestBed.tick();
  return p;
}

describe('ExpiryPicker', () => {
  beforeAll(() => TestBed.initTestEnvironment(NoDom, platformCore()));
  afterAll(() => TestBed.resetTestEnvironment());

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('opening the editor on an existing expiry keeps it to the second', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-08T15:00:00'));
    // Expired at 09:30 today: moving it to the end of today would bring the share back.
    const exact = new Date('2026-10-08T09:30:00').toISOString();
    const p = open(exact);
    expect(p.expiresAt()).toBe(exact);
  });

  it('a choice the user makes sets the expiry', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-08T15:00:00'));
    const p = open(null);
    p['pick']('7');
    expect(p.expiresAt()).toBe(new Date('2026-10-15T15:00:00').toISOString());
    p['pick']('custom');
    p['pickDate']('2026-11-01');
    expect(p.expiresAt()).toBe(new Date('2026-11-01T23:59:59').toISOString());
    p['pick']('none');
    expect(p.expiresAt()).toBeNull();
  });
});
