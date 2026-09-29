import { ChangeDetectionStrategy, Component, DestroyRef, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Keyboard } from './core/keyboard';
import { RouteSync } from './core/route-sync';
import { DialogHost } from './dialogs/dialog-host';
import { Sidebar } from './sidebar/sidebar';
import { TreeStore } from './state/tree-store';
import { UiStore } from './state/ui-store';
import { Icon } from './ui/icon';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, Sidebar, DialogHost, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  host: { '(document:keydown)': 'keyboard.handle($event)' },
})
export class App {
  protected readonly ui = inject(UiStore);
  protected readonly store = inject(TreeStore);
  protected readonly keyboard = inject(Keyboard);

  constructor() {
    inject(RouteSync).start(inject(DestroyRef));
    void this.store.init();
  }
}
