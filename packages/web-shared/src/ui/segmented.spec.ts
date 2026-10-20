import '@angular/compiler'; // JIT: reads the component's metadata without the Angular CLI.
import { reflectComponentType } from '@angular/core';
import { describe, expect, it } from 'vitest';
import * as shared from '../index';
import { Segmented, segmentStep } from './segmented';

describe('Segmented', () => {
  it('is <app-segmented>, exported for the apps', () => {
    expect(reflectComponentType(Segmented)?.selector).toBe('app-segmented');
    expect(shared.Segmented).toBe(Segmented);
  });

  it('moves with the arrow keys (wrapping), Home and End, from the focused option', () => {
    expect(segmentStep('ArrowRight', 0, 3)).toBe(1);
    expect(segmentStep('ArrowDown', 2, 3)).toBe(0);
    expect(segmentStep('ArrowLeft', 0, 3)).toBe(2);
    expect(segmentStep('ArrowUp', 1, 3)).toBe(0);
    expect(segmentStep('Home', 2, 3)).toBe(0);
    expect(segmentStep('End', 0, 3)).toBe(2);
    expect(segmentStep('Enter', 0, 3)).toBeNull();
  });
});
