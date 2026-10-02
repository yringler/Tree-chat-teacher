import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  type OnInit,
  signal,
  viewChild,
} from '@angular/core';
import type { LoginOptionsResponse } from '@tangent/shared';
import { AuthService, loginErrorMessage, type SocialProvider } from '../core/auth';
import { Icon } from '../ui/icon';
import { Turnstile } from '../ui/turnstile';

/**
 * `/login`, always loaded as its own document (see AuthService). No
 * passwords: Google, GitHub, a magic link by email, or a passkey.
 */
@Component({
  selector: 'app-login-page',
  imports: [Icon, Turnstile],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="login">
      <section class="login-card" aria-labelledby="login-title">
        <h1 id="login-title" class="login-brand"><app-icon name="tree" [size]="22" /> Tangent</h1>

        @if (error(); as e) {
          <p class="notice notice-error" role="alert">{{ e }}</p>
        }

        @if (options(); as o) {
          @if (!o.configured) {
            <p class="notice">
              Sign-in isn't set up on this server (BETTER_AUTH_SECRET is not set).
              @if (o.devMode) {
                Dev mode is on, so you can <a href="/">go straight to the app</a>.
              }
            </p>
          } @else if (sentTo(); as email) {
            <p class="lead">Check your email</p>
            <p>
              We sent a sign-in link to <strong>{{ email }}</strong>. It works once and expires in
              15 minutes.
            </p>
            <button type="button" class="btn btn-ghost" (click)="sentTo.set(null)">
              Use a different method
            </button>
          } @else {
            <div class="login-methods">
              @if (o.social.google) {
                <button
                  type="button"
                  class="btn login-btn"
                  [disabled]="busy()"
                  (click)="social('google')"
                >
                  Continue with Google
                </button>
              }
              @if (o.social.github) {
                <button
                  type="button"
                  class="btn login-btn"
                  [disabled]="busy()"
                  (click)="social('github')"
                >
                  Continue with GitHub
                </button>
              }
              <button type="button" class="btn login-btn" [disabled]="busy()" (click)="passkey()">
                <app-icon name="key" /> Sign in with a passkey
              </button>
            </div>

            <div class="login-divider" role="separator"><span>or get a link by email</span></div>

            <form class="form" (submit)="$event.preventDefault(); sendLink()">
              <label class="field">
                <span class="field-label">Email</span>
                <input
                  #emailInput
                  type="email"
                  name="email"
                  required
                  autocomplete="username webauthn"
                  [value]="email()"
                  (input)="email.set(emailInput.value)"
                />
              </label>
              @if (o.turnstileSiteKey; as siteKey) {
                <app-turnstile
                  #captcha
                  [siteKey]="siteKey"
                  (token)="captchaToken.set($event)"
                  (failed)="error.set($event)"
                />
              } @else {
                <p class="notice small">
                  Email sign-in is unavailable: TURNSTILE_SITE_KEY is not set.
                </p>
              }
              <button type="submit" class="btn btn-primary" [disabled]="!canSendLink()">
                Email me a sign-in link
              </button>
            </form>

            <label class="login-remember">
              <input
                type="checkbox"
                name="remember"
                [checked]="remember()"
                (change)="toggleRemember()"
              />
              Remember me
              <span class="muted small"
                >(stay signed in for 30 days; otherwise until you close the browser)</span
              >
            </label>
          }
        } @else if (!error()) {
          <p class="muted">Loading…</p>
        }
      </section>
    </main>
  `,
})
export class LoginPage implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly captcha = viewChild<Turnstile>('captcha');

  protected readonly options = signal<LoginOptionsResponse | null>(null);
  protected readonly error = signal<string | null>(
    loginErrorMessage(new URLSearchParams(location.search).get('error')),
  );
  protected readonly busy = signal(false);
  protected readonly sentTo = signal<string | null>(null);
  protected readonly captchaToken = signal<string | null>(null);
  protected readonly email = signal('');
  protected readonly remember = signal(this.auth.rememberPreference);

  protected readonly canSendLink = computed(
    () => !this.busy() && !!this.captchaToken() && this.email().includes('@'),
  );

  async ngOnInit(): Promise<void> {
    try {
      const options = await this.auth.loginOptions();
      if (options.devMode) {
        location.replace('/');
        return;
      }
      if (options.configured && (await this.auth.hasSession())) {
        location.replace('/');
        return;
      }
      this.options.set(options);
      // Offer saved passkeys in the email field's autofill where the browser supports it.
      if (options.configured && (await PublicKeyCredential.isConditionalMediationAvailable?.())) {
        void this.auth.signInPasskey(this.remember(), true);
      }
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    }
  }

  protected toggleRemember(): void {
    this.remember.set(!this.remember());
    this.auth.setRemember(this.remember());
  }

  protected async social(provider: SocialProvider): Promise<void> {
    await this.run(() => this.auth.signInSocial(provider, this.remember()));
  }

  protected async passkey(): Promise<void> {
    await this.run(() => this.auth.signInPasskey(this.remember()));
  }

  protected async sendLink(): Promise<void> {
    const token = this.captchaToken();
    const email = this.email().trim();
    if (!token || !email) return;
    const ok = await this.run(() => this.auth.sendMagicLink(email, token, this.remember()));
    this.captcha()?.reset();
    if (ok) this.sentTo.set(email);
  }

  /** Runs one sign-in step; returns true when it reported no error. */
  private async run(step: () => Promise<string | null>): Promise<boolean> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const message = await step();
      if (message) this.error.set(message);
      return !message;
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}
