import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Icon } from '@tangent/web-shared';
import { LessonStore } from '../state/lesson-store';

/**
 * "Import" on the lesson list: picks a JSON backup (made in Learn or in power
 * mode) and imports it as a new lesson (LessonStore.importLesson).
 */
@Component({
  selector: 'app-import-lesson-button',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="btn btn-ghost btn-sm"
      title="Import a lesson or conversation from a JSON backup"
      [disabled]="store.importing()"
      (click)="file.click()"
    >
      <app-icon name="upload" [size]="14" /> {{ store.importing() ? 'Importing…' : 'Import' }}
    </button>
    <input
      #file
      type="file"
      accept="application/json,.json"
      hidden
      aria-label="Backup file to import"
      (change)="pick(file)"
    />
  `,
})
export class ImportLessonButton {
  protected readonly store = inject(LessonStore);

  protected pick(input: HTMLInputElement): void {
    const f = input.files?.[0];
    input.value = '';
    if (f) void this.store.importLesson(f);
  }
}
