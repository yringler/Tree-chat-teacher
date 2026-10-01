import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { TangentProbe } from '@tangent/web-shared';

/** Simple-mode shell, served under /learn/ (wave 3: `simple-app`). */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, TangentProbe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main>
      <router-outlet />
    </main>
    <tangent-probe />
  `,
})
export class App {}
