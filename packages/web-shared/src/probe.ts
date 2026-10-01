import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Wave 1 probe (foundation): proved that both Angular apps compile (AOT) this
 * TS-source library. apps/web no longer renders it; removed in wave 3 once
 * apps/simple stops importing it.
 */
@Component({
  selector: 'tangent-probe',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '<span hidden data-tangent-probe>{{ name }}</span>',
})
export class TangentProbe {
  protected readonly name = '@tangent/web-shared';
}
