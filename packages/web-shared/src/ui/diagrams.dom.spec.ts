import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MAX_DIAGRAM_SOURCE, renderMarkdown } from '@tangent/render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../testing';
import { DIAGRAM_FAILED_NOTE, RenderDiagrams } from './diagrams';
import { selectionText } from './math';

/** Stands in for mermaid: draws an <svg> naming its theme, with a node and an edge, or fails on "broken". */
const draw = vi.hoisted(() =>
  vi.fn((source: string, theme: string, host: HTMLElement): Promise<boolean> => {
    if (source.includes('broken')) return Promise.resolve(false);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('data-theme', theme);
    svg.style.maxWidth = '1000px';
    const svgElement = (tag: string, cls: string, text = ''): Element => {
      const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
      if (cls) el.setAttribute('class', cls);
      el.textContent = text;
      return el;
    };
    const node = svgElement('g', 'node');
    node.append(svgElement('text', '', 'Label'), svgElement('text', '', 'member'));
    const edge = svgElement('g', 'edgeLabel');
    edge.append(svgElement('text', '', 'yes'));
    svg.append(node, edge, svgElement('g', 'node'));
    host.replaceChildren(svg);
    return Promise.resolve(true);
  }),
);
vi.mock('./mermaid-render', () => ({ drawMermaid: draw }));

@Component({
  selector: 'app-host',
  imports: [RenderDiagrams],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div
    [innerHTML]="html()"
    [appRenderDiagrams]="html()"
    [diagramsPaused]="paused()"
  ></div>`,
})
class Host {
  readonly html = input('');
  readonly paused = input(false);
}

const SOURCE = 'flowchart LR\n  A --> B\n';
const reply = (source = SOURCE): string =>
  renderMarkdown('Before\n\n```mermaid\n' + source + '```\n\nAfter');

/** The OS colour scheme, switchable mid-test. */
function scheme(dark: boolean): (dark: boolean) => void {
  const listeners: ((e: { matches: boolean }) => void)[] = [];
  const query = {
    matches: dark,
    addEventListener: (_: string, l: (e: { matches: boolean }) => void) => listeners.push(l),
  };
  vi.stubGlobal('matchMedia', () => query);
  return (next) => {
    query.matches = next;
    for (const l of listeners) l({ matches: next });
  };
}

function diagram(host: HTMLElement): HTMLElement {
  const el = host.querySelector<HTMLElement>('.diagram');
  if (!el) throw new Error('no diagram');
  return el;
}

describe('RenderDiagrams', () => {
  beforeEach(() => scheme(false));
  afterEach(() => {
    vi.unstubAllGlobals();
    draw.mockClear();
  });

  it("draws a finished reply's diagram in place of its code", async () => {
    const { host } = await render(Host, { inputs: { html: reply() } });
    await vi.waitFor(() => expect(diagram(host).classList).toContain('is-drawn'));
    const figure = diagram(host).querySelector('.diagram-figure');
    expect(figure?.getAttribute('role')).toBe('img');
    // Named by its nodes' labels, without edge labels, as the Flutter app names it.
    expect(figure?.getAttribute('aria-label')).toBe('Diagram: Label');
    expect(figure?.querySelector('svg')?.getAttribute('data-theme')).toBe('default');
    expect(draw).toHaveBeenCalledExactlyOnceWith(SOURCE, 'default', figure);
    // A wide drawing shrinks only so far, then scrolls.
    expect(figure?.querySelector('svg')?.style.minWidth).toBe('600px');
  });

  it("shows a streaming reply's diagram as code, and draws it once the reply ends", async () => {
    const r = await render(Host, { inputs: { html: reply(), paused: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(draw).not.toHaveBeenCalled();
    expect(diagram(r.host).querySelector('pre')?.textContent).toBe(SOURCE);
    await r.set({ paused: false });
    await vi.waitFor(() => expect(diagram(r.host).classList).toContain('is-drawn'));
  });

  it("shows the source under a note when the diagram can't be drawn", async () => {
    const r = await render(Host, { inputs: { html: reply('flowchart broken\n') } });
    await vi.waitFor(() => expect(diagram(r.host).classList).toContain('is-failed'));
    expect(diagram(r.host).querySelector('.diagram-note')?.textContent).toBe(DIAGRAM_FAILED_NOTE);
    expect(diagram(r.host).querySelector('pre')?.textContent).toBe('flowchart broken\n');
    // It isn't tried again on the next render.
    r.fixture.detectChanges();
    await r.fixture.whenStable();
    expect(draw).toHaveBeenCalledTimes(1);
    expect(r.host.querySelectorAll('.diagram-note')).toHaveLength(1);
  });

  it('draws a source of exactly the limit', async () => {
    const source = 'flowchart LR\n' + 'x'.repeat(MAX_DIAGRAM_SOURCE - 14) + '\n';
    expect(source).toHaveLength(MAX_DIAGRAM_SOURCE);
    const { host } = await render(Host, { inputs: { html: reply(source) } });
    await vi.waitFor(() => expect(diagram(host).classList).toContain('is-drawn'));
  });

  it('never draws a source over the limit', async () => {
    const long = 'flowchart LR\n' + 'A --> B\n'.repeat(MAX_DIAGRAM_SOURCE / 8);
    const { host } = await render(Host, { inputs: { html: reply(long) } });
    await vi.waitFor(() => expect(diagram(host).classList).toContain('is-failed'));
    expect(draw).not.toHaveBeenCalled();
  });

  it('redraws in the dark theme when the colour scheme changes', async () => {
    const setDark = scheme(false);
    const { host } = await render(Host, { inputs: { html: reply() } });
    await vi.waitFor(() => expect(diagram(host).classList).toContain('is-drawn'));
    setDark(true);
    await vi.waitFor(() =>
      expect(host.querySelector('.diagram-figure svg')?.getAttribute('data-theme')).toBe('dark'),
    );
    expect(host.querySelectorAll('.diagram-figure')).toHaveLength(1);
    expect(host.querySelectorAll('.diagram-toggle')).toHaveLength(1);
  });

  it('leaves alone a reply that re-rendered while its diagram was drawn', async () => {
    let finish = (): void => undefined;
    draw.mockImplementationOnce(
      (_source, _theme, figure) =>
        new Promise((resolve) => {
          finish = () => {
            figure.append(document.createElement('svg'));
            resolve(true);
          };
        }),
    );
    const r = await render(Host, { inputs: { html: reply() } });
    await vi.waitFor(() => expect(draw).toHaveBeenCalledTimes(1));
    const stale = diagram(r.host);
    await r.set({ html: renderMarkdown('No diagram now.') });
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stale.isConnected).toBe(false);
    expect(stale.querySelector('.diagram-figure')).toBeNull();
    expect(r.host.textContent?.trim()).toBe('No diagram now.');
  });

  it('swaps the drawing for its source and back', async () => {
    const { host } = await render(Host, { inputs: { html: reply() } });
    await vi.waitFor(() => expect(diagram(host).classList).toContain('is-drawn'));
    const toggle = host.querySelector<HTMLButtonElement>('.diagram-toggle');
    expect(toggle?.textContent).toBe('Show source');
    toggle?.click();
    expect(diagram(host).classList).toContain('show-source');
    expect(toggle?.textContent).toBe('Show diagram');
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    toggle?.click();
    expect(diagram(host).classList).not.toContain('show-source');
  });
});

describe('selectionText: diagrams', () => {
  beforeEach(() => scheme(false));
  afterEach(() => {
    vi.unstubAllGlobals();
    window.getSelection()?.removeAllRanges();
  });

  async function select(source: string, from: 'label' | 'before'): Promise<string> {
    const { host } = await render(Host, { inputs: { html: reply(source) } });
    await vi.waitFor(() => expect(diagram(host).classList).toContain('is-drawn'));
    const label = host.querySelector('.diagram-figure text')?.firstChild;
    const before = host.querySelector('p')?.firstChild;
    if (!label || !before) throw new Error('nothing to select');
    const range = document.createRange();
    if (from === 'label') range.setStart(label, 1);
    else range.setStart(before, 0);
    range.setEnd(label, 3);
    const selection = window.getSelection();
    if (!selection) throw new Error('no selection');
    selection.removeAllRanges();
    selection.addRange(range);
    return selectionText(selection);
  }

  it('takes the whole source of a diagram the selection starts in', async () => {
    expect(await select(SOURCE, 'label')).toBe('```mermaid\nflowchart LR\n  A --> B\n```');
  });

  it('takes the whole source of a diagram the selection ends in', async () => {
    expect(await select(SOURCE, 'before')).toBe(
      'Before\n\n```mermaid\nflowchart LR\n  A --> B\n```',
    );
  });

  it("keeps the source's indentation, which a mindmap needs", async () => {
    const mindmap = 'mindmap\n  root\n    child\n      grandchild\n';
    expect(await select(mindmap, 'label')).toBe('```mermaid\n' + mindmap + '```');
  });
});
