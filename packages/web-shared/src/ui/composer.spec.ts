import '@angular/compiler'; // JIT: the component in the same module.
import { describe, expect, it, vi } from 'vitest';
import {
  ComposerController,
  joinWhenRendered,
  refocusesWhenEnabled,
  releasesDraft,
} from './composer';

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

describe('ComposerController and a page with one box', () => {
  it("focuses the page's one box for a request that names a branch (a branch just made)", () => {
    const c = new ComposerController();
    const single = box(null);
    c.attach(single);
    c.focus('new');
    expect(single.focus).toHaveBeenCalledTimes(1);
    // Nothing is left waiting for a box of 'new'.
    const later = box('new', false);
    c.attach(later);
    expect(later.focus).not.toHaveBeenCalled();
  });
});

describe('Composer helpers', () => {
  it('a box joins once rendered, so a request for its branch made before it existed is matched', () => {
    const c = new ComposerController();
    let lane: string | null = null;
    const lanes = { ...box(null, false), branchId: () => lane };
    const rendered: (() => void)[] = [];
    const destroyed: (() => void)[] = [];
    joinWhenRendered(
      c,
      lanes,
      (fn) => rendered.push(fn),
      (fn) => destroyed.push(fn),
    );
    // Asked for the new lane before its box rendered: nothing to focus yet.
    c.focus('lane-1');
    expect(lanes.focus).not.toHaveBeenCalled();
    // Its inputs are set, then it renders: it takes the request.
    lane = 'lane-1';
    for (const fn of rendered) fn();
    expect(lanes.focus).toHaveBeenCalledTimes(1);
    // Destroyed: it leaves.
    for (const fn of destroyed) fn();
    c.sent('lane-1', 'x');
    expect(lanes.release).not.toHaveBeenCalled();
  });

  it('lets a sent draft go only where the box clears on send, and only unedited', () => {
    expect(releasesDraft(' Why? ', 'Why?', true)).toBe(true);
    expect(releasesDraft('Why? And how?', 'Why?', true)).toBe(false);
    expect(releasesDraft('Why?', 'Why?', false)).toBe(false);
  });

  it("takes the focus back after a reply in the page's one box only, when nothing has it, on hover", () => {
    const at = { disabled: false, branchId: null, nothingFocused: true, hovers: true };
    expect(refocusesWhenEnabled(at)).toBe(true);
    expect(refocusesWhenEnabled({ ...at, branchId: 'lane' })).toBe(false);
    expect(refocusesWhenEnabled({ ...at, disabled: true })).toBe(false);
    expect(refocusesWhenEnabled({ ...at, nothingFocused: false })).toBe(false);
    expect(refocusesWhenEnabled({ ...at, hovers: false })).toBe(false);
  });
});
