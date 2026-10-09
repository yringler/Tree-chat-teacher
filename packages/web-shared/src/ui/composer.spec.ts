import '@angular/compiler'; // JIT: the component in the same module.
import { describe, expect, it, vi } from 'vitest';
import { ComposerController } from './composer';

function box(branchId: string | null, current = true) {
  return {
    branchId: () => branchId,
    current: () => current,
    focus: vi.fn(),
    insert: vi.fn(),
    release: vi.fn(),
  };
}

describe('ComposerController', () => {
  it('focuses the current box, or the box of the branch it names', () => {
    const c = new ComposerController();
    const a = box('a', true);
    const b = box('b', false);
    c.attach(a);
    c.attach(b);
    c.focus();
    expect(a.focus).toHaveBeenCalledTimes(1);
    c.focus('b');
    expect(b.focus).toHaveBeenCalledTimes(1);
    expect(a.focus).toHaveBeenCalledTimes(1);
  });

  it('keeps a request for a box not on the page yet, for that box to take once it is', () => {
    const c = new ComposerController();
    c.focus('new');
    const later = box('new', false);
    c.attach(later);
    expect(later.focus).toHaveBeenCalledTimes(1);
    // Taken once: another box of that branch isn't focused again.
    const again = box('new', false);
    c.attach(again);
    expect(again.focus).not.toHaveBeenCalled();
  });

  it("lets a sent message go from its branch's box, and from a page's one box", () => {
    const c = new ComposerController();
    const lane = box('a');
    const other = box('b');
    const single = box(null);
    c.attach(lane);
    c.attach(other);
    c.attach(single);
    c.sent('a', 'Why?');
    expect(lane.release).toHaveBeenCalledWith('Why?');
    expect(single.release).toHaveBeenCalledWith('Why?');
    expect(other.release).not.toHaveBeenCalled();
  });

  it('hands text to the current box, and forgets a box taken off the page', () => {
    const c = new ComposerController();
    const b = box(null);
    const detach = c.attach(b);
    c.insert('Corrections');
    expect(b.insert).toHaveBeenCalledWith('Corrections');
    detach();
    c.focus();
    c.sent('a', 'x');
    expect(b.focus).not.toHaveBeenCalled();
    expect(b.release).not.toHaveBeenCalled();
  });
});
