import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { ProviderInfo } from '@tangent/shared';

/*
 * A power branch on the user's own key, in a browser that has none (it was
 * forgotten, it expired, or this is another device: the key lives in a cookie
 * of the browser that saved it). The branch's route is only its default:
 * Tangent credit, another provider or a key entered now all carry on, and
 * the message the server refused (401 `key_required`, before anything was
 * written) is sent once the user picks one. The power app and Canvas.
 */

/** A message the server refused for want of the branch's own API key, to send once a way on is picked. */
export interface BlockedSend {
  branchId: string;
  content: string;
  /** "Check sources": the reply must search. */
  ground?: 'required';
}

/** `list` with `send` in it: one waiting message per branch, the latest. */
export function addBlockedSend(
  list: readonly BlockedSend[],
  send: BlockedSend,
): readonly BlockedSend[] {
  return [...list.filter((s) => s.branchId !== send.branchId), send];
}

/**
 * A route (a branch, a provider entry) that needs the user's own key and has
 * none here: its provider takes a user key, and the server lists it as
 * unavailable (no key saved in this browser, and no server key). Tangent
 * credit never does.
 */
export function keyMissing(
  provider: Pick<ProviderInfo, 'available' | 'acceptsUserKey' | 'funding'> | null | undefined,
): boolean {
  return (
    !!provider &&
    (provider.funding ?? 'own-key') === 'own-key' &&
    provider.acceptsUserKey &&
    !provider.available
  );
}

/** The words of `KeyMissingNotice`. */
export interface KeyMissingText {
  /** The first sentence, in bold. */
  lead: string;
  body: string;
}

/**
 * What the keys dialog says above its key form after a send was refused for
 * want of a key. `credit`: Tangent credit can carry the branch on (the button
 * is offered); `keyForm`: the dialog can take a key (a server without
 * KEY_ENCRYPTION_SECRET can't).
 */
export function keyMissingText(
  branchTitle: string,
  providerLabel: string,
  credit: boolean,
  keyForm: boolean,
): KeyMissingText {
  const where = `“${branchTitle}” replies on ${providerLabel} with your own API key, and none is saved in this browser.`;
  const ways = [
    credit ? 'continue it on Tangent credit' : null,
    keyForm ? `enter your ${providerLabel} key below` : null,
  ].filter((w): w is string => w !== null);
  const how =
    ways.length > 0
      ? ` To send it, ${ways.join(', or ')}; any other provider or model is in the branch’s settings.`
      : ' To send it, pick another provider or model in the branch’s settings.';
  return { lead: 'Your message wasn’t sent.', body: where + how };
}

let uid = 0;

/**
 * Tops the keys dialog after a send was refused for want of the branch's own
 * key (`BlockedSend`): says so, and offers to carry the branch on with
 * Tangent credit (`useCredit`: the app moves the branch onto credit and sends
 * the message) where it can. Saving a key below sends it too (the app does
 * that). Styles: `.read-only-panel` in base.css.
 */
@Component({
  selector: 'app-key-missing-notice',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'key-missing-notice' },
  template: `
    <section class="read-only-panel" role="region" [attr.aria-labelledby]="leadId">
      <p class="read-only-text">
        <strong [id]="leadId">{{ text().lead }}</strong> {{ text().body }}
      </p>
      @if (credit()) {
        <div class="read-only-actions">
          <button
            type="button"
            class="btn btn-primary key-missing-credit"
            [disabled]="busy()"
            (click)="useCredit.emit()"
          >
            {{ busy() ? 'Switching…' : 'Continue on Tangent credit' }}
          </button>
          @if (balance(); as b) {
            <span class="muted small">{{ b }} available</span>
          }
        </div>
      }
    </section>
  `,
})
export class KeyMissingNotice {
  /** The branch whose message was refused. */
  readonly branchTitle = input.required<string>();
  /** Its provider, as the provider list labels it ("OpenRouter"). */
  readonly providerLabel = input.required<string>();
  /** Tangent credit can carry the branch on: offer it. */
  readonly credit = input(false);
  /** The credit available ("$4.20"), when known. */
  readonly balance = input<string | null>(null);
  /** The dialog has a key form below. */
  readonly keyForm = input(true);
  readonly busy = input(false);
  /** "Continue on Tangent credit": the app moves the branch onto credit and sends the message. */
  readonly useCredit = output();

  protected readonly leadId = `key-missing-lead-${++uid}`;
  protected readonly text = computed(() =>
    keyMissingText(this.branchTitle(), this.providerLabel(), this.credit(), this.keyForm()),
  );
}
