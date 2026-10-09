import '@angular/compiler'; // JIT: reads the components' metadata without the Angular CLI.
import { reflectComponentType } from '@angular/core';
import { describe, expect, it } from 'vitest';
import * as shared from '../index';
import { NodePicker } from './node-picker';
import { RelatedLinks } from './related-links';

describe('the links components', () => {
  it('are <app-related-links> and <app-node-picker>, exported for the three apps', () => {
    expect(reflectComponentType(RelatedLinks)?.selector).toBe('app-related-links');
    expect(shared.RelatedLinks).toBe(RelatedLinks);
    expect(reflectComponentType(NodePicker)?.selector).toBe('app-node-picker');
    expect(shared.NodePicker).toBe(NodePicker);
  });
});
