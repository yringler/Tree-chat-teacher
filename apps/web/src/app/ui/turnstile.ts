import {
  ChangeDetectionStrategy,
  Component,
  type ElementRef,
  input,
  type OnDestroy,
  output,
  viewChild,
  afterNextRender,
} from '@angular/core';

interface TurnstileRenderOptions {
  sitekey: string;
  action?: string;
  theme?: 'auto' | 'light' | 'dark';
  size?: 'normal' | 'flexible' | 'compact';
  callback: (token: string) => void;
  'expired-callback': () => void;
  'error-callback': () => void;
}

interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<TurnstileApi> | null = null;

/**
 * Loads Turnstile once. Only the login page's CSP allows this origin
 * (public/_headers), so this only ever runs in the login document.
 */
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile did not load'));
    script.onerror = () => {
      loading = null;
      reject(new Error('Turnstile could not be loaded'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/** Cloudflare Turnstile widget. Emits a token when solved and null when it expires or fails. */
@Component({
  selector: 'app-turnstile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div #box class="turnstile"></div>`,
})
export class Turnstile implements OnDestroy {
  readonly siteKey = input.required<string>();
  readonly action = input('magic-link');
  readonly token = output<string | null>();
  readonly failed = output<string>();

  private readonly box = viewChild.required<ElementRef<HTMLElement>>('box');
  private api: TurnstileApi | null = null;
  private widgetId: string | null = null;
  private destroyed = false;

  constructor() {
    afterNextRender(() => {
      loadTurnstile().then(
        (api) => {
          if (this.destroyed) return;
          this.api = api;
          this.widgetId = api.render(this.box().nativeElement, {
            sitekey: this.siteKey(),
            action: this.action(),
            theme: 'auto',
            size: 'flexible',
            callback: (t) => this.token.emit(t),
            'expired-callback': () => this.token.emit(null),
            'error-callback': () => this.token.emit(null),
          });
        },
        (err: unknown) => this.failed.emit(err instanceof Error ? err.message : String(err)),
      );
    });
  }

  /** Tokens are single-use: get a fresh one after each submit. */
  reset(): void {
    this.token.emit(null);
    if (this.api && this.widgetId) this.api.reset(this.widgetId);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.api && this.widgetId) this.api.remove(this.widgetId);
  }
}
