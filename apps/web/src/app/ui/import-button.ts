import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Icon, readBackupFile } from '@tangent/web-shared';
import { TreeStore } from '../state/tree-store';

/** "Import backup" button: file input → validate → POST /api/import → open the new tree. */
@Component({
  selector: 'app-import-button',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button type="button" class="btn btn-ghost" [disabled]="busy()" (click)="file.click()">
      <app-icon name="upload" /> {{ busy() ? 'Importing…' : 'Import backup' }}
    </button>
    <input #file type="file" accept="application/json,.json" hidden (change)="pick(file)" />
  `,
})
export class ImportButton {
  private readonly store = inject(TreeStore);
  protected readonly busy = signal(false);

  protected async pick(input: HTMLInputElement): Promise<void> {
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    this.busy.set(true);
    try {
      await this.store.importTree(await readBackupFile(f));
    } catch (err) {
      this.store.fail(err);
    } finally {
      this.busy.set(false);
    }
  }
}
