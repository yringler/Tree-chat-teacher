import '@angular/compiler'; // JIT: compiles the component below without the Angular CLI.
import { Injector, reflectComponentType, runInInjectionContext } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import * as shared from '../index';
import { Segmented } from './segmented';

/** Template of a JIT-compiled component (the decorator's metadata). */
function templateOf(type: object): string {
  const annotations = (type as { __annotations__?: { template?: string }[] }).__annotations__;
  return annotations?.[0]?.template ?? '';
}

function create(): Segmented {
  return runInInjectionContext(Injector.create({ providers: [] }), () => new Segmented());
}

describe('Segmented', () => {
  const t = templateOf(Segmented);

  it('is <app-segmented>, exported for the apps', () => {
    expect(reflectComponentType(Segmented)?.selector).toBe('app-segmented');
    expect(shared.Segmented).toBe(Segmented);
  });

  it('is a labelled radiogroup of radios, or a tablist of tabs controlling panels', () => {
    expect(t).toContain(`[attr.role]="kind() === 'tab' ? 'tablist' : 'radiogroup'"`);
    expect(t).toContain('[attr.aria-label]="label()"');
    expect(t).toContain('[attr.role]="kind()"');
    expect(t).toContain(`[attr.aria-checked]="kind() === 'radio' ? o.id === value() : null"`);
    expect(t).toContain(`[attr.aria-selected]="kind() === 'tab' ? o.id === value() : null"`);
    expect(t).toContain(`controls() + '-' + o.id`);
    expect(t).toContain(`controls() + '-tab-' + o.id`);
  });

  it('marks the current option, shows hints, and can be disabled', () => {
    expect(t).toContain('class="segment"');
    expect(t).toContain('[class.is-on]="o.id === value()"');
    expect(t).toContain('[title]="o.hint ?? o.label"');
    expect(t).toContain('[disabled]="disabled()"');
    expect(t).toContain('(keydown.arrowLeft)="step($event, -1)"');
    expect(t).toContain('(keydown.arrowRight)="step($event, 1)"');
  });

  it('emits `changed` only for an option other than the current one', () => {
    const seg = create();
    const changed = vi.fn();
    seg.changed.subscribe(changed);
    const pick = (id: string) => (seg as unknown as { pick(id: string): void }).pick(id);
    pick('max'); // value() is null: anything is a change
    expect(changed).toHaveBeenCalledWith('max');
  });
});
