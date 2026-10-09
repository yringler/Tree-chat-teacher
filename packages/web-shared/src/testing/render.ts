import { provideZonelessChangeDetection, type Provider, type Type } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';

export interface Rendered<T> {
  fixture: ComponentFixture<T>;
  /** The component instance, for its outputs. */
  component: T;
  /** The host element, to query within. */
  host: HTMLElement;
  /** Sets inputs, then waits for the view to show them. */
  set(inputs: Record<string, unknown>): Promise<void>;
}

/**
 * Renders `type` into the document with TestBed, zoneless as in the apps,
 * with `inputs` set and `providers` (stores and API stubs) available to it.
 */
export async function render<T>(
  type: Type<T>,
  opts: { inputs?: Record<string, unknown>; providers?: Provider[] } = {},
): Promise<Rendered<T>> {
  TestBed.configureTestingModule({
    imports: [type],
    providers: [provideZonelessChangeDetection(), ...(opts.providers ?? [])],
  });
  const fixture = TestBed.createComponent(type);
  const set = async (inputs: Record<string, unknown>) => {
    for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
    await fixture.whenStable();
  };
  await set(opts.inputs ?? {});
  return { fixture, component: fixture.componentInstance, host: fixture.nativeElement, set };
}
