import { computed, signal } from '@angular/core';

/**
 * An app's open modal dialogs, as one stack of a discriminated union (`kind`
 * names the dialog, the rest is what it was opened with). A dialog opened
 * from another (the keys dialog over Compare, say) goes on top, and only the
 * top one answers Escape (`closeTop`); opening a kind already open moves it
 * to the top with its new state, so no dialog is ever open twice. While any
 * is open (`anyOpen`), the app's shortcuts wait (`dispatchShortcut`).
 */
export class Overlays<D extends { readonly kind: string }> {
  private readonly stack = signal<readonly D[]>([]);
  /** The open dialogs, bottom first: a host renders them in this order, so the top one is on top. */
  readonly list = this.stack.asReadonly();
  readonly anyOpen = computed(() => this.stack().length > 0);
  readonly top = computed<D | null>(() => this.stack().at(-1) ?? null);

  open(dialog: D): void {
    this.stack.update((list) => [...list.filter((d) => d.kind !== dialog.kind), dialog]);
  }

  /** Opens `dialog`, or closes it when one of its kind is open. */
  toggle(dialog: D): void {
    if (this.isOpen(dialog.kind)) this.close(dialog.kind);
    else this.open(dialog);
  }

  /** The open dialog of `kind`, with its state; null when it isn't open. */
  get<K extends D['kind']>(kind: K): Extract<D, { kind: K }> | null {
    return this.stack().find((d): d is Extract<D, { kind: K }> => d.kind === kind) ?? null;
  }

  isOpen(kind: D['kind']): boolean {
    return this.stack().some((d) => d.kind === kind);
  }

  close(kind: D['kind']): void {
    if (this.isOpen(kind)) this.stack.update((list) => list.filter((d) => d.kind !== kind));
  }

  /** Escape: closes the top-most dialog. False when none is open. */
  closeTop(): boolean {
    if (!this.anyOpen()) return false;
    this.stack.update((list) => list.slice(0, -1));
    return true;
  }
}
