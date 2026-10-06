import '@angular/compiler'; // JIT: compiles the component below without the Angular CLI.
import { Injector, reflectComponentType, runInInjectionContext } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { provideTextSize, TextSizeStore } from '../core/text-size-store';
import { TextSizeMenu } from './text-size-menu';

/** Template of a JIT-compiled component (the decorator's metadata). */
function templateOf(type: object): string {
  const annotations = (type as { __annotations__?: { template?: string }[] }).__annotations__;
  return annotations?.[0]?.template ?? '';
}

function create(): TextSizeMenu {
  const injector = Injector.create({
    providers: [{ provide: TextSizeStore }, provideTextSize('tangent.test.chatFontScale')],
  });
  return runInInjectionContext(injector, () => new TextSizeMenu());
}

describe('TextSizeMenu', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('is <app-text-size-menu>: "Aa" opening A−, the size, A+ and Reset', () => {
    expect(reflectComponentType(TextSizeMenu)?.selector).toBe('app-text-size-menu');
    const t = templateOf(TextSizeMenu);
    expect(t).toContain('aria-label="Text size"');
    expect(t).toContain('[attr.aria-expanded]="open()"');
    expect(t).toContain('aria-label="Smaller text"');
    expect(t).toContain('aria-label="Larger text"');
    expect(t).toContain('Reset to 100%');
    expect(t).toContain('(keydown.escape)="close($event, trigger)"');
    // Shortcuts are named only where the app has them.
    expect(t).toContain("shortcuts() ? 'Text size (- / +)' : 'Text size'");
  });

  it('Escape closes it, hands focus back to "Aa" and keeps the app from seeing the key', () => {
    const menu = create();
    menu.open.set(true);
    const e = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    const trigger = { focus: vi.fn() };
    (menu as unknown as { close(e: unknown, t: unknown): void }).close(e, trigger);
    expect(menu.open()).toBe(false);
    expect(trigger.focus).toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.stopPropagation).toHaveBeenCalled();
  });

  it('Escape while closed is left to the app', () => {
    const menu = create();
    const e = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    (menu as unknown as { close(e: unknown, t: unknown): void }).close(e, { focus: vi.fn() });
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(e.stopPropagation).not.toHaveBeenCalled();
  });
});
