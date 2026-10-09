import { describe, expect, it } from 'vitest';
import { Overlays } from './overlays';

type Dialog =
  | { kind: 'keys'; provider: string | null }
  | { kind: 'compare'; branchId: string }
  | { kind: 'help' };

describe('Overlays', () => {
  it('opens dialogs on top of each other, and Escape closes the top-most first', () => {
    const o = new Overlays<Dialog>();
    expect(o.anyOpen()).toBe(false);
    o.open({ kind: 'compare', branchId: 'b1' });
    o.open({ kind: 'keys', provider: 'openrouter' });
    expect(o.top()).toEqual({ kind: 'keys', provider: 'openrouter' });
    expect(o.get('compare')).toEqual({ kind: 'compare', branchId: 'b1' });
    expect(o.closeTop()).toBe(true);
    expect(o.isOpen('keys')).toBe(false);
    expect(o.top()?.kind).toBe('compare');
    expect(o.closeTop()).toBe(true);
    expect(o.anyOpen()).toBe(false);
    expect(o.closeTop()).toBe(false);
  });

  it('never opens one kind twice: opening it again moves it to the top with its new state', () => {
    const o = new Overlays<Dialog>();
    o.open({ kind: 'keys', provider: null });
    o.open({ kind: 'help' });
    o.open({ kind: 'keys', provider: 'anthropic' });
    expect(o.get('keys')).toEqual({ kind: 'keys', provider: 'anthropic' });
    expect(o.top()?.kind).toBe('keys');
    o.closeTop();
    expect(o.top()?.kind).toBe('help');
    expect(o.isOpen('keys')).toBe(false);
  });

  it('closes one kind wherever it is, and toggles', () => {
    const o = new Overlays<Dialog>();
    o.open({ kind: 'help' });
    o.open({ kind: 'compare', branchId: 'b1' });
    o.close('help');
    expect(o.isOpen('help')).toBe(false);
    expect(o.get('compare')).not.toBeNull();
    o.toggle({ kind: 'help' });
    expect(o.top()?.kind).toBe('help');
    o.toggle({ kind: 'help' });
    expect(o.isOpen('help')).toBe(false);
  });
});
