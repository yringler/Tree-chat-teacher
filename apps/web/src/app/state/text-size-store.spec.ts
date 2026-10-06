import '@angular/compiler'; // JIT: lets the DI below compile @Injectable classes without the Angular CLI.
import { Injector } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TEXT_SIZE,
  parseTextSize,
  TEXT_SIZE_STEPS,
  TextSizeStore,
} from './text-size-store';

const KEY = 'tangent.chatFontScale';

function create(): TextSizeStore {
  return Injector.create({ providers: [{ provide: TextSizeStore }] }).get(TextSizeStore);
}

describe('parseTextSize', () => {
  it('reads a saved step, and anything else as the default', () => {
    expect(parseTextSize('1.25')).toBe(1.25);
    expect(parseTextSize('0.85')).toBe(0.85);
    for (const raw of [null, '', 'big', '1.3', '7', '-1', 'NaN', 'Infinity', '{"scale":1.25}']) {
      expect(parseTextSize(raw)).toBe(DEFAULT_TEXT_SIZE);
    }
  });
});

describe('TextSizeStore', () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    storage = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts at 100% with nothing saved', () => {
    const s = create();
    expect(s.scale()).toBe(1);
    expect(s.label()).toBe('100%');
    expect(s.isDefault()).toBe(true);
    expect(s.canIncrease()).toBe(true);
    expect(s.canDecrease()).toBe(true);
  });

  it('steps up and down through the ladder', () => {
    const s = create();
    s.increase();
    expect(s.scale()).toBe(1.12);
    expect(s.label()).toBe('112%');
    expect(s.isDefault()).toBe(false);
    s.decrease();
    s.decrease();
    expect(s.scale()).toBe(0.92);
    expect(s.label()).toBe('92%');
  });

  it('stops at both ends', () => {
    const s = create();
    for (let i = 0; i < 10; i++) s.increase();
    expect(s.scale()).toBe(TEXT_SIZE_STEPS.at(-1));
    expect(s.label()).toBe('140%');
    expect(s.canIncrease()).toBe(false);
    expect(s.canDecrease()).toBe(true);
    for (let i = 0; i < 10; i++) s.decrease();
    expect(s.scale()).toBe(TEXT_SIZE_STEPS[0]);
    expect(s.label()).toBe('85%');
    expect(s.canDecrease()).toBe(false);
    expect(s.canIncrease()).toBe(true);
  });

  it('remembers the size in localStorage, and Reset forgets it', () => {
    const s = create();
    s.increase();
    s.increase();
    expect(storage.get(KEY)).toBe('1.25');
    expect(create().scale()).toBe(1.25);

    s.reset();
    expect(s.scale()).toBe(1);
    expect(storage.has(KEY)).toBe(false);
    expect(create().scale()).toBe(1);
  });

  it('ignores a garbage value saved under the key', () => {
    storage.set(KEY, 'huge');
    const s = create();
    expect(s.scale()).toBe(1);
    // And steps from the default, not from the garbage.
    s.increase();
    expect(s.scale()).toBe(1.12);
  });

  it('works in memory when storage is blocked', () => {
    const blocked = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked, removeItem: blocked });
    const s = create();
    expect(s.scale()).toBe(1);
    s.increase();
    expect(s.scale()).toBe(1.12);
    s.reset();
    expect(s.scale()).toBe(1);
  });

  it('works without localStorage at all', () => {
    vi.stubGlobal('localStorage', undefined);
    const s = create();
    expect(s.scale()).toBe(1);
    s.decrease();
    expect(s.scale()).toBe(0.92);
  });
});
