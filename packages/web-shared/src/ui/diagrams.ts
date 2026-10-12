import {
  afterRenderEffect,
  computed,
  Directive,
  ElementRef,
  inject,
  Injectable,
  input,
  signal,
} from '@angular/core';
import { MAX_DIAGRAM_SOURCE } from '@tangent/render';
import type { DiagramTheme, drawMermaid } from './mermaid-render';

/** Shown above the source of a diagram that can't be drawn; the Flutter app shows the same. */
export const DIAGRAM_FAILED_NOTE = 'This diagram could not be drawn.';

type Draw = typeof drawMermaid;

/** Loaded on first use: most replies have no diagram, and mermaid is large. */
let loading: Promise<Draw> | null = null;

function loadDraw(): Promise<Draw> {
  loading ??= import('./mermaid-render').then(
    (m) => m.drawMermaid,
    (err: unknown) => {
      loading = null; // e.g. a chunk lost to a deploy; retry on the next render
      throw err;
    },
  );
  return loading;
}

/** The colour scheme the apps follow (base.css switches on the same media query). */
@Injectable({ providedIn: 'root' })
export class DiagramScheme {
  private readonly query =
    typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  private readonly dark = signal(this.query?.matches ?? false);
  readonly theme = computed<DiagramTheme>(() => (this.dark() ? 'dark' : 'default'));

  constructor() {
    this.query?.addEventListener('change', (e) => this.dark.set(e.matches));
  }
}

interface DiagramState {
  /** The theme the shown drawing has, or null before the first. */
  drawn: DiagramTheme | null;
  busy: boolean;
  failed: boolean;
}

const states = new WeakMap<HTMLElement, DiagramState>();

/** The diagram's source: the text of the code block `renderMarkdown` put in it. */
function sourceOf(diagram: Element): string {
  return diagram.querySelector(':scope > pre')?.textContent ?? '';
}

function showFailure(diagram: HTMLElement): void {
  const note = document.createElement('p');
  note.className = 'diagram-note';
  note.textContent = DIAGRAM_FAILED_NOTE;
  diagram.prepend(note);
  diagram.classList.add('is-failed');
}

/** A button that swaps the drawing for its source and back. */
function sourceToggle(diagram: HTMLElement): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'diagram-toggle btn btn-ghost btn-sm';
  button.textContent = 'Show source';
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', (e) => {
    e.stopPropagation(); // not a click on the message
    const open = diagram.classList.toggle('show-source');
    button.textContent = open ? 'Show diagram' : 'Show source';
    button.setAttribute('aria-expanded', String(open));
  });
  return button;
}

/**
 * Mermaid sizes a drawing to its column, up to its natural width (an inline
 * `max-width`). A wide one shrinks only to this share of that width and
 * scrolls beyond it, so its labels stay readable on a phone.
 */
const MIN_SCALE = 0.6;

function limitShrinking(figure: HTMLElement): void {
  const svg = figure.querySelector('svg');
  const natural = Number.parseFloat(svg?.style.maxWidth ?? '');
  if (svg && natural > 0) svg.style.minWidth = `${Math.round(natural * MIN_SCALE)}px`;
}

/**
 * Where mermaid puts the labels of a diagram's nodes (flowchart, state,
 * class, ER and mindmap nodes, timeline events, sequence participants, pie
 * slices, gantt tasks). Edge labels are left out, as the Flutter app does.
 */
const NODES = 'g.node, g.timeline-node, text.actor, g.legend text, text[class*="taskText"]';

/**
 * "Diagram: " and its node labels, comma-separated ("Diagram" without any),
 * as the Flutter app labels a diagram. A node's first label is its name; a
 * class's or an entity's members come after it.
 */
function accessibleLabel(figure: HTMLElement): string {
  const labels = new Set<string>();
  for (const node of figure.querySelectorAll(NODES)) {
    const label = node.matches('g') ? (node.querySelector('.nodeLabel, text') ?? node) : node;
    const text = (label.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text) labels.add(text);
  }
  return labels.size === 0 ? 'Diagram' : `Diagram: ${[...labels].join(', ')}`;
}

async function drawDiagram(diagram: HTMLElement, theme: () => DiagramTheme): Promise<void> {
  const state = states.get(diagram) ?? { drawn: null, busy: false, failed: false };
  states.set(diagram, state);
  const want = theme();
  if (state.busy || state.failed || state.drawn === want) return;
  const source = sourceOf(diagram);
  const figure = document.createElement('div');
  figure.className = 'diagram-figure';
  figure.setAttribute('role', 'img');

  state.busy = true;
  let ok: boolean;
  try {
    ok = source.length <= MAX_DIAGRAM_SOURCE && (await (await loadDraw())(source, want, figure));
  } catch (err) {
    console.error('Mermaid failed to load', err);
    state.busy = false;
    return; // left as code; the next render tries again
  }
  state.busy = false;
  // The reply may have re-rendered (or gone) while mermaid worked.
  if (!diagram.isConnected) return;
  if (!ok) {
    state.failed = true;
    showFailure(diagram);
    return;
  }
  limitShrinking(figure);
  figure.setAttribute('aria-label', accessibleLabel(figure));
  const shown = diagram.querySelector(':scope > .diagram-figure');
  if (shown) shown.replaceWith(figure);
  else {
    diagram.prepend(figure, sourceToggle(diagram));
    diagram.classList.add('is-drawn');
  }
  state.drawn = want;
  if (theme() !== want) await drawDiagram(diagram, theme); // the scheme changed meanwhile
}

/**
 * Draws the diagram placeholders `renderMarkdown` emits under `root`
 * (`<div class="diagram">` around a code block of mermaid source), in
 * `theme`, and redraws drawn ones whose theme changed. Each runs once: one
 * that can't be drawn keeps its source, under a note saying so.
 */
export function renderDiagrams(root: HTMLElement, theme: () => DiagramTheme): void {
  for (const diagram of root.querySelectorAll<HTMLElement>('div.diagram'))
    void drawDiagram(diagram, theme);
}

/**
 * Put next to `[innerHTML]`, bound to the same HTML string, with whether the
 * text is still streaming:
 * `<div [innerHTML]="html()" [appRenderDiagrams]="html()" [diagramsPaused]="streaming()">`.
 * Like `TypesetMath`, it works on the live DOM, after Angular's sanitizer,
 * which strips SVG. A streaming reply shows its diagrams as code: a
 * half-written one rarely parses, and a whole one would be redrawn on every
 * delta.
 */
@Directive({ selector: '[appRenderDiagrams]' })
export class RenderDiagrams {
  readonly appRenderDiagrams = input.required<string>();
  readonly diagramsPaused = input(false);

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const { theme } = inject(DiagramScheme);
    afterRenderEffect(() => {
      this.appRenderDiagrams();
      if (this.diagramsPaused()) return;
      theme(); // redraw when the scheme changes
      renderDiagrams(host, theme);
    });
  }
}
