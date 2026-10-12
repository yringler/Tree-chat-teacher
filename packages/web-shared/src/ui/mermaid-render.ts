/// <reference types="trusted-types" />
import { MAX_DIAGRAM_SOURCE } from '@tangent/render';
import DOMPurify, { type Config } from 'dompurify';
import mermaid, { type MermaidConfig } from 'mermaid';

/**
 * Mermaid behind the apps' Trusted Types policy. Loaded on first use
 * (`RenderDiagrams` imports this module dynamically), so neither mermaid nor
 * DOMPurify is in an app's initial bundle.
 */

export type DiagramTheme = 'default' | 'dark';

const CONFIG: MermaidConfig = {
  startOnLoad: false,
  securityLevel: 'strict',
  suppressErrorRendering: true,
  maxTextSize: MAX_DIAGRAM_SOURCE,
  // Mermaid's own default is ELK, a 1.4 MB chunk; dagre ships with the core.
  layout: 'dagre',
  mindmap: { layout: 'cose-bilkent' },
  // Mermaid's secure keys, plus `layout`, so a diagram's %%{init}%% can't switch to ELK.
  secure: [
    'secure',
    'securityLevel',
    'startOnLoad',
    'maxTextSize',
    'suppressErrorRendering',
    'maxEdges',
    'layout',
  ],
};

/**
 * HTML labels live in <foreignObject>, so the HTML profile is needed beside
 * SVG's (SVG's alone blanks the labels). <img> is dropped, so a label can't
 * fetch even a same-origin URL.
 */
const PURIFY: Config = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true },
  ADD_TAGS: ['foreignObject'],
  HTML_INTEGRATION_POINTS: { foreignobject: true },
  FORBID_TAGS: ['img'],
};

/** How many renders are running; the default policy accepts strings only while one is. */
let rendering = 0;
let queue: Promise<unknown> = Promise.resolve();
let seq = 0;
let scratch: HTMLElement | null = null;

/**
 * The apps' CSP allows Angular's policies and DOMPurify's, plus a `default`
 * policy, which the browser applies to every string a script hands an HTML
 * sink. Mermaid writes its styles and some labels through `innerHTML`, so
 * this policy exists from the moment mermaid is loaded, and it refuses every
 * string outside a mermaid render (as the CSP did before it existed) and
 * sanitizes the ones inside one, rather than letting them through.
 */
export const defaultPolicyRules = {
  createHTML(html: string): string {
    if (rendering === 0) throw new TypeError('An HTML string outside a diagram render');
    // Without a '<' a string parses to text alone; DOMPurify would only re-encode it.
    return html.includes('<') ? DOMPurify.sanitize(html, PURIFY) : html;
  },
};
window.trustedTypes?.createPolicy('default', defaultPolicyRules);

/**
 * Where mermaid draws: laid out (it measures text) but off screen. Under
 * `display: none` every label would measure zero.
 */
function scratchElement(): HTMLElement {
  if (scratch?.isConnected) return scratch;
  scratch = document.createElement('div');
  scratch.setAttribute('aria-hidden', 'true');
  Object.assign(scratch.style, {
    position: 'fixed',
    left: '-10000px',
    top: '0',
    visibility: 'hidden',
  });
  document.body.append(scratch);
  return scratch;
}

/**
 * Draws `source` into `host` and resolves true; resolves false, leaving
 * `host` untouched, when mermaid can't parse or render it. `initialize` is
 * global, so renders run one at a time, each initializing its own theme.
 */
export function drawMermaid(
  source: string,
  theme: DiagramTheme,
  host: HTMLElement,
): Promise<boolean> {
  if (source.length > MAX_DIAGRAM_SOURCE) return Promise.resolve(false);
  const job = queue.then(async () => {
    mermaid.initialize({ ...CONFIG, theme });
    if (!(await mermaid.parse(source, { suppressErrors: true }))) return false;
    const into = scratchElement();
    rendering++;
    try {
      const { svg } = await mermaid.render(`tangent-diagram-${++seq}`, source, into);
      host.replaceChildren(DOMPurify.sanitize(svg, { ...PURIFY, RETURN_DOM_FRAGMENT: true }));
      return true;
    } catch {
      return false;
    } finally {
      rendering--;
      into.replaceChildren(); // mermaid leaves its working node behind when it throws
    }
  });
  queue = job.catch(() => undefined);
  return job;
}
