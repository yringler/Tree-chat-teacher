import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dispatchShortcut, pathKeys, type ShortcutEvent, type ShortcutFrame } from './shortcuts';

/** The DOM classes the dispatcher checks targets against (the suite runs in Node). */
class FakeElement {
  isContentEditable = false;
  constructor(readonly tagName: string) {}
  blur = vi.fn();
}

beforeAll(() => {
  vi.stubGlobal('HTMLElement', FakeElement);
});
afterAll(() => vi.unstubAllGlobals());

function key(k: string, over: Partial<ShortcutEvent> = {}): ShortcutEvent {
  let prevented = false;
  return {
    key: k,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    target: new FakeElement('BODY'),
    get defaultPrevented() {
      return prevented;
    },
    preventDefault: () => {
      prevented = true;
    },
    ...over,
  };
}

function frame(over: Partial<ShortcutFrame> = {}) {
  return {
    closeTop: vi.fn(() => false),
    dialogOpen: vi.fn(() => false),
    toggleHelp: vi.fn(),
    navigate: vi.fn(() => true),
    keys: { j: vi.fn(), b: vi.fn(() => false) },
    ...over,
  };
}

describe('dispatchShortcut', () => {
  it('runs an app key and takes it, unless the key leaves it to the browser', () => {
    const f = frame();
    const j = key('j');
    dispatchShortcut(j, f);
    expect(f.keys.j).toHaveBeenCalled();
    expect(j.defaultPrevented).toBe(true);
    const b = key('b');
    dispatchShortcut(b, f);
    expect(f.keys.b).toHaveBeenCalled();
    expect(b.defaultPrevented).toBe(false);
  });

  it('runs no shortcut behind an open dialog; Escape and ? still work', () => {
    const f = frame({ dialogOpen: () => true, closeTop: vi.fn(() => true) });
    dispatchShortcut(key('j'), f);
    dispatchShortcut(key('ArrowUp', { altKey: true }), f);
    expect(f.keys.j).not.toHaveBeenCalled();
    expect(f.navigate).not.toHaveBeenCalled();
    dispatchShortcut(key('?'), f);
    expect(f.toggleHelp).toHaveBeenCalled();
    const esc = key('Escape');
    dispatchShortcut(esc, f);
    expect(f.closeTop).toHaveBeenCalled();
    expect(esc.defaultPrevented).toBe(true);
  });

  it('ignores keys typed in a field, with Ctrl or Cmd; Escape there leaves the field', () => {
    const f = frame();
    const field = new FakeElement('TEXTAREA');
    dispatchShortcut(key('j', { target: field }), f);
    dispatchShortcut(key('j', { ctrlKey: true }), f);
    expect(f.keys.j).not.toHaveBeenCalled();
    dispatchShortcut(key('Escape', { target: field }), f);
    expect(field.blur).toHaveBeenCalled();
  });

  it('moves among branches with Alt+arrows, taking the key only when it moved', () => {
    const f = frame({ navigate: vi.fn(() => false) });
    const up = key('ArrowUp', { altKey: true });
    dispatchShortcut(up, f);
    expect(f.navigate).toHaveBeenCalledWith('parent');
    expect(up.defaultPrevented).toBe(false);
  });

  it('leaves ? alone in an app without shortcut help', () => {
    const q = key('?');
    dispatchShortcut(q, { closeTop: () => false, dialogOpen: () => false });
    expect(q.defaultPrevented).toBe(false);
  });

  it('leaves keys that are composing text (an input method) alone, Escape too', () => {
    const f = frame({ closeTop: vi.fn(() => true) });
    dispatchShortcut(key('j', { isComposing: true }), f);
    dispatchShortcut(key('Escape', { isComposing: true }), f);
    expect(f.keys.j).not.toHaveBeenCalled();
    expect(f.closeTop).not.toHaveBeenCalled();
  });
});

describe('pathKeys', () => {
  it('moves up and down the tree with [ and ], along the path with j and k', () => {
    const nav = { navigate: vi.fn(() => true), moveFocus: vi.fn(() => true) };
    const keys = pathKeys(nav);
    keys['[']?.();
    keys[']']?.();
    keys.j?.();
    keys.k?.();
    expect(nav.navigate.mock.calls).toEqual([['parent'], ['firstChild']]);
    expect(nav.moveFocus.mock.calls).toEqual([[1], [-1]]);
  });

  it('leaves the key to the browser when there is nowhere to go', () => {
    const nav = { navigate: vi.fn(() => false), moveFocus: vi.fn(() => false) };
    const j = key('j');
    dispatchShortcut(j, { closeTop: () => false, dialogOpen: () => false, keys: pathKeys(nav) });
    expect(nav.moveFocus).toHaveBeenCalledWith(1);
    expect(j.defaultPrevented).toBe(false);
  });
});
