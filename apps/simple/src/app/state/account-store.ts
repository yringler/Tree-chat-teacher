import { Injectable, signal } from '@angular/core';
import type { MeResponse } from '@tangent/shared';

/** The signed-in caller (`/api/me`). Who pays for their replies is LearnFunding's. */
@Injectable({ providedIn: 'root' })
export class AccountStore {
  readonly me = signal<MeResponse | null>(null);
}
