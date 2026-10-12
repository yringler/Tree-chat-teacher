import { MAX_DIAGRAM_SOURCE } from '@tangent/render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drawMermaid } from './mermaid-render';

interface Rules {
  createHTML(html: string): string;
}

/** The policies created through the page's Trusted Types factory, by name. */
const policies = vi.hoisted(() => {
  const created = new Map<string, Rules>();
  Object.defineProperty(window, 'trustedTypes', {
    configurable: true,
    value: {
      createPolicy: (name: string, rules: Rules) => {
        created.set(name, rules);
        return rules;
      },
    },
  });
  return created;
});

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn<(config: Record<string, unknown>) => void>(),
  parse: vi.fn<(source: string) => Promise<unknown>>(),
  render: vi.fn<(id: string, source: string) => Promise<{ svg: string }>>(),
}));
vi.mock('mermaid', () => ({ default: mermaid }));

/**
 * happy-dom's parser breaks DOMPurify (it keeps <img> and <script>), so the
 * sanitizing itself is checked in a real browser (apps/e2e `diagrams.spec.ts`);
 * here it marks what it was given.
 */
const purify = vi.hoisted(() => ({
  sanitize: vi.fn((html: string, config: { RETURN_DOM_FRAGMENT?: boolean }) => {
    if (!config.RETURN_DOM_FRAGMENT) return `clean(${html})`;
    const fragment = document.createDocumentFragment();
    const mark = document.createElement('span');
    mark.className = 'sanitized';
    mark.textContent = html;
    fragment.append(mark);
    return fragment;
  }),
}));
vi.mock('dompurify', () => ({ default: purify }));

function defaultPolicy(): Rules {
  const rules = policies.get('default');
  if (!rules) throw new Error('no default policy');
  return rules;
}

const SOURCE = 'flowchart LR\n  A --> B';

/** SVG with HTML labels in <foreignObject>, and no <img>, which could fetch. */
const PURIFY = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true },
  ADD_TAGS: ['foreignObject'],
  HTML_INTEGRATION_POINTS: { foreignobject: true },
  FORBID_TAGS: ['img'],
};

describe('the default Trusted Types policy', () => {
  beforeEach(() => {
    mermaid.parse.mockResolvedValue({ diagramType: 'flowchart' });
  });
  afterEach(() => vi.clearAllMocks());

  it('exists once mermaid has loaded', () => {
    expect(policies.has('default')).toBe(true);
  });

  it('refuses every string outside a diagram render', () => {
    expect(() => defaultPolicy().createHTML('<b>x</b>')).toThrow(TypeError);
    expect(() => defaultPolicy().createHTML('plain')).toThrow(TypeError);
  });

  it('sanitizes the HTML strings mermaid writes while it renders', async () => {
    const seen: string[] = [];
    mermaid.render.mockImplementation(() => {
      seen.push(defaultPolicy().createHTML('<b>ok</b>'), defaultPolicy().createHTML('a & b'));
      return Promise.resolve({ svg: '<svg></svg>' });
    });
    expect(await drawMermaid(SOURCE, 'default', document.createElement('div'))).toBe(true);
    // A string without '<' parses to text alone, so it needs no sanitizing.
    expect(seen).toEqual(['clean(<b>ok</b>)', 'a & b']);
    expect(purify.sanitize).toHaveBeenCalledWith('<b>ok</b>', PURIFY);
    expect(() => defaultPolicy().createHTML('<b>x</b>')).toThrow(TypeError);
  });

  it('closes again when a render fails', async () => {
    mermaid.render.mockRejectedValue(new Error('bad'));
    expect(await drawMermaid(SOURCE, 'default', document.createElement('div'))).toBe(false);
    expect(() => defaultPolicy().createHTML('<b>x</b>')).toThrow(TypeError);
  });
});

describe('drawMermaid', () => {
  beforeEach(() => {
    mermaid.parse.mockResolvedValue({ diagramType: 'flowchart' });
  });
  afterEach(() => vi.clearAllMocks());

  it('sanitizes the drawing into nodes before it reaches the page', async () => {
    mermaid.render.mockResolvedValue({ svg: '<svg id="d"></svg>' });
    const host = document.createElement('div');
    expect(await drawMermaid(SOURCE, 'default', host)).toBe(true);
    expect(purify.sanitize).toHaveBeenCalledWith('<svg id="d"></svg>', {
      ...PURIFY,
      RETURN_DOM_FRAGMENT: true,
    });
    expect(host.querySelector('.sanitized')?.textContent).toBe('<svg id="d"></svg>');
  });

  it('initializes each render with its theme, strict and on dagre, ELK locked out', async () => {
    mermaid.render.mockResolvedValue({ svg: '<svg></svg>' });
    await drawMermaid(SOURCE, 'dark', document.createElement('div'));
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: 'dark',
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        maxTextSize: MAX_DIAGRAM_SOURCE,
        layout: 'dagre',
        secure: expect.arrayContaining(['layout', 'securityLevel', 'maxTextSize']) as unknown,
      }),
    );
  });

  it("leaves the host untouched when the source doesn't parse", async () => {
    mermaid.parse.mockResolvedValue(false);
    const host = document.createElement('div');
    host.textContent = 'before';
    expect(await drawMermaid('flowchart TD\n  A[Start] -->', 'default', host)).toBe(false);
    expect(mermaid.render).not.toHaveBeenCalled();
    expect(host.textContent).toBe('before');
  });

  it('never hands mermaid a source over the limit', async () => {
    const long = 'flowchart LR\n' + 'A --> B\n'.repeat(MAX_DIAGRAM_SOURCE / 8);
    expect(await drawMermaid(long, 'default', document.createElement('div'))).toBe(false);
    expect(mermaid.parse).not.toHaveBeenCalled();
  });

  it('renders one diagram at a time, each with its own theme', async () => {
    let finish = (): void => undefined;
    mermaid.render.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ svg: '<svg></svg>' });
        }),
    );
    mermaid.render.mockResolvedValue({ svg: '<svg></svg>' });
    const first = drawMermaid(SOURCE, 'default', document.createElement('div'));
    const second = drawMermaid(SOURCE, 'dark', document.createElement('div'));
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1));
    expect(mermaid.initialize).toHaveBeenCalledTimes(1);
    finish();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(mermaid.initialize.mock.calls.map(([c]) => c['theme'])).toEqual(['default', 'dark']);
  });
});
