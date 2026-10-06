import '@angular/compiler'; // JIT: the component metadata below.
import { reflectComponentType } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { HomePage } from './home-page';
import { ImportLessonButton } from './import-lesson-button';

/** Template of a JIT-compiled component (the decorator's metadata). */
function templateOf(type: object): string {
  const annotations = (type as { __annotations__?: { template?: string }[] }).__annotations__;
  return annotations?.[0]?.template ?? '';
}

describe('Learn import and export', () => {
  it('the lesson list has Import in its heading and Export next to Delete on every lesson', () => {
    const t = templateOf(HomePage);
    expect(t).toMatch(/<h2 id="lessons-title">Your lessons<\/h2>\s*<app-import-lesson-button \/>/);
    expect(t).toContain('No lessons yet. Start one above, or import a backup.');
    // Export, then Delete, in each row.
    const row = t.slice(t.indexOf('<li class="lesson-row">'), t.indexOf('</li>'));
    expect(row).toContain(`[attr.aria-label]="'Export ' + lessonTitle(t.title)"`);
    expect(row).toContain('(click)="store.exportLesson(t.id)"');
    expect(row).toContain('[disabled]="store.exportingId() !== null"');
    expect(row.indexOf('name="download"')).toBeLessThan(row.indexOf('name="trash"'));
  });

  it('Import picks a JSON file and hands it to the store, once at a time', () => {
    expect(reflectComponentType(ImportLessonButton)?.selector).toBe('app-import-lesson-button');
    const t = templateOf(ImportLessonButton);
    expect(t).toContain('accept="application/json,.json"');
    expect(t).toContain('(change)="pick(file)"');
    expect(t).toContain('[disabled]="store.importing()"');
    expect(t).toContain("{{ store.importing() ? 'Importing…' : 'Import' }}");
  });
});
