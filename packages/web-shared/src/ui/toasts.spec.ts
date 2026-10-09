import '@angular/compiler'; // JIT: the component in the same module.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastStore } from './toasts';

describe('ToastStore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows the newest three, with their links', () => {
    const t = new ToastStore();
    t.notify('one');
    t.notify('two');
    t.notify('three', 'error', { label: 'Add credit', path: '/billing' });
    t.notify('four');
    expect(t.toasts().map((x) => x.text)).toEqual(['two', 'three', 'four']);
    expect(t.toasts()[1]).toMatchObject({ kind: 'error', link: { label: 'Add credit' } });
  });

  it('dismisses an info toast sooner than an error', () => {
    const t = new ToastStore();
    t.notify('saved');
    t.notify('failed', 'error');
    vi.advanceTimersByTime(4000);
    expect(t.toasts().map((x) => x.text)).toEqual(['failed']);
    vi.advanceTimersByTime(4000);
    expect(t.toasts()).toEqual([]);
  });

  it('dismisses one by hand', () => {
    const t = new ToastStore();
    t.notify('a');
    t.notify('b');
    t.dismiss(t.toasts()[0]!.id);
    expect(t.toasts().map((x) => x.text)).toEqual(['b']);
  });
});
