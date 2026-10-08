import '@angular/compiler'; // JIT: compiles the component below without the Angular CLI.
import { Injector, reflectComponentType, runInInjectionContext } from '@angular/core';
import { describe, expect, it } from 'vitest';
import * as shared from '../index';
import { Compare, type CompareCandidate } from './compare';

/** Metadata of a JIT-compiled component (the decorator's). */
function metaOf(type: object): { template: string; host: Record<string, string> } {
  const annotations = (
    type as { __annotations__?: { template?: string; host?: Record<string, string> }[] }
  ).__annotations__;
  return { template: annotations?.[0]?.template ?? '', host: annotations?.[0]?.host ?? {} };
}

describe('Compare', () => {
  const { template: t, host } = metaOf(Compare);

  it('is <app-compare class="compare">, exported for the apps', () => {
    expect(reflectComponentType(Compare)?.selector).toBe('app-compare');
    expect(host['class']).toBe('compare');
    expect(shared.Compare).toBe(Compare);
  });

  it('shows the question and the note when given', () => {
    expect(t).toContain('<p class="compare-question" [title]="question()">{{ question() }}</p>');
    expect(t).toContain('<p class="compare-note muted small">{{ note() }}</p>');
  });

  it('switches answers with a tablist (narrow screens) controlling one tabpanel per answer', () => {
    expect(t).toContain('<div class="compare-tabs">');
    expect(t).toContain('kind="tab"');
    expect(t).toContain('[controls]="prefix"');
    expect(t).toContain('(changed)="active.set($event)"');
    // Tab roles only while there are tabs: side by side, each answer is a labelled region.
    expect(t).toContain(`[attr.role]="wide() ? 'region' : 'tabpanel'"`);
    expect(host['(window:resize)']).toBe('wide.set(sideBySide())');
    expect(t).toContain(`[id]="prefix + '-' + c.id"`);
    expect(t).toContain('[attr.data-active]="c.id === shown()"');
    expect(t).toContain(`[attr.aria-labelledby]="prefix + '-head-' + c.id"`);
  });

  it('renders each answer as typeset HTML, announcing the one shown (every one, side by side)', () => {
    expect(t).toContain('class="compare-body md"');
    expect(t).toContain('[innerHTML]="c.html"');
    expect(t).toContain('[appTypesetMath]="c.html"');
    expect(t).toContain(`[attr.aria-live]="wide() || c.id === shown() ? 'polite' : null"`);
  });

  it('offers a pick only for a finished answer, and none while a pick is saving', () => {
    expect(t).toContain(`[disabled]="c.state !== 'done' || busy()"`);
    expect(t).toContain('(click)="picked.emit(c.id)"');
    expect(t).toContain('{{ pickLabel() }}');
  });

  it('says what went wrong with an answer, else how it is going', () => {
    expect(t).toContain(`@if (c.state === 'error') {`);
    expect(t).toContain(`{{ c.error || 'Something went wrong' }}`);
    expect(t).toContain('} @else if (progress(c); as text) {');
  });

  it('reads progress from the latest status, else the state', () => {
    const compare = runInInjectionContext(Injector.create({ providers: [] }), () => new Compare());
    const progress = (c: Partial<CompareCandidate>) =>
      (compare as unknown as { progress(c: CompareCandidate): string | null }).progress({
        id: 'a',
        label: 'Normal',
        state: 'streaming',
        html: '',
        ...c,
      });
    expect(progress({ status: 'Searching the web…' })).toBe('Searching the web…');
    expect(progress({ state: 'pending' })).toBe('Waiting…');
    expect(progress({})).toBe('Writing…');
    expect(progress({ state: 'done' })).toBeNull();
  });

  it('knows whether the answers sit side by side (no matchMedia: tabs)', () => {
    const wideOf = () =>
      (
        runInInjectionContext(
          Injector.create({ providers: [] }),
          () => new Compare(),
        ) as unknown as {
          wide(): boolean;
        }
      ).wide();
    expect(wideOf()).toBe(false);
    const original = globalThis.matchMedia;
    globalThis.matchMedia = ((q: string) => ({ matches: q === '(min-width: 900px)' })) as never;
    try {
      expect(wideOf()).toBe(true);
    } finally {
      globalThis.matchMedia = original;
    }
  });
});
