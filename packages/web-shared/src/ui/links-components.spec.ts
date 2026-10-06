import '@angular/compiler'; // JIT: compiles the components below without the Angular CLI.
import { reflectComponentType } from '@angular/core';
import { describe, expect, it } from 'vitest';
import * as shared from '../index';
import { NodePicker } from './node-picker';
import { RelatedLinks } from './related-links';

/** Metadata of a JIT-compiled component (the decorator's). */
function metaOf(type: object): { template: string; host: Record<string, string> } {
  const annotations = (
    type as { __annotations__?: { template?: string; host?: Record<string, string> }[] }
  ).__annotations__;
  return { template: annotations?.[0]?.template ?? '', host: annotations?.[0]?.host ?? {} };
}

describe('RelatedLinks', () => {
  const t = metaOf(RelatedLinks).template;

  it('is <app-related-links>, exported for the three apps', () => {
    expect(reflectComponentType(RelatedLinks)?.selector).toBe('app-related-links');
    expect(shared.RelatedLinks).toBe(RelatedLinks);
  });

  it('renders nothing without links, and a toggle that says whether it is open', () => {
    expect(t).toContain('@if (list.length > 0) {');
    expect(t).toContain('[attr.aria-expanded]="expanded()"');
    expect(t).toContain('[attr.aria-controls]="listId"');
  });

  it('chips are buttons opening the other end; edit and remove are labelled and only for editors', () => {
    expect(t).toContain('(click)="$event.stopPropagation(); open.emit(e.nodeId)"');
    expect(t).toContain('@if (canEdit()) {');
    expect(t).toContain(`[attr.aria-label]="'Remove the ' + noun() + ' to ' + e.title"`);
    expect(t).toContain(`[attr.aria-label]="'Edit the note on the ' + noun() + ' to ' + e.title"`);
    expect(t).toContain('[maxLength]="maxNote"');
  });
});

describe('NodePicker', () => {
  const { template: t, host } = metaOf(NodePicker);

  it('is <app-node-picker>, exported for the three apps; Cancel cancels', () => {
    expect(reflectComponentType(NodePicker)?.selector).toBe('app-node-picker');
    expect(shared.NodePicker).toBe(NodePicker);
    expect(t).toContain('(click)="cancelled.emit()"');
  });

  it('is a combobox over a listbox of options, focused by Modal', () => {
    expect(t).toContain('role="combobox"');
    expect(t).toContain('autofocus');
    expect(t).toContain('[attr.aria-activedescendant]="activeId()"');
    expect(t).toContain('role="listbox"');
    expect(t).toContain('role="option"');
    expect(t).toContain('[attr.aria-selected]="i === active()"');
    expect(t).toContain('(keydown)="searchKey($event)"');
  });

  it('cancels on Escape anywhere inside it, and offers a slot for another way to pick', () => {
    expect(host['(keydown.escape)']).toBe('escape($event)');
    expect(t).toContain('<ng-content />');
  });
});
