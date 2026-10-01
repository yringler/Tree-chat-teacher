import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Wave 1 probe (foundation): proves that both Angular apps compile (AOT) a
 * TS-source Angular library linked through pnpm. Renders nothing visible.
 * Removed by the `web-shared` agent once real shared code lives here.
 */
@Component({
  selector: 'tangent-probe',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '<span hidden data-tangent-probe>{{ name }}</span>',
})
export class TangentProbe {
  protected readonly name = '@tangent/web-shared';
}
