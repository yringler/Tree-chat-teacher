import '@angular/compiler'; // JIT: reads the component's metadata without the Angular CLI.
import { reflectComponentType } from '@angular/core';
import { describe, expect, it } from 'vitest';
import * as shared from '../index';
import { Compare } from './compare';

describe('Compare', () => {
  it('is <app-compare>, exported for the apps', () => {
    expect(reflectComponentType(Compare)?.selector).toBe('app-compare');
    expect(shared.Compare).toBe(Compare);
  });
});
