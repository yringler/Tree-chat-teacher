/**
 * Grounding: web search through OpenRouter's `openrouter:web_search` server
 * tool, offered on the turns a free server-side gate picks (see
 * @tangent/core `decideGrounding`), with the model deciding whether to use it
 * (at most once per reply). The learner can force it with "Check sources".
 * See docs/DECISIONS.md § Grounding.
 */

/** A source a grounded reply cites (OpenRouter `url_citation` annotation). */
export interface Citation {
  url: string;
  title: string | null;
  /** Short excerpt for the UI only; never sent back to the model. */
  excerpt: string | null;
}

/** Per-branch grounding setting (power mode). Learn uses `auto`. */
export type GroundingMode = 'off' | 'auto' | 'always';
export const GROUNDING_MODES: readonly GroundingMode[] = ['off', 'auto', 'always'];
export const DEFAULT_GROUNDING_MODE: GroundingMode = 'auto';

/** Longest excerpt kept per citation. */
export const CITATION_EXCERPT_MAX = 300;
/** Most citations kept per reply. */
export const CITATIONS_MAX = 20;

/**
 * Appended to the system prompt when the web search tool is offered. The
 * model decides whether to search; links it cites stay in the reply text,
 * so later turns and child branches inherit them as already-checked facts.
 */
export const GROUNDING_INSTRUCTIONS = `## Checking facts

You can call the web_search tool once for this reply. Use it only when the answer depends on specifics you could misremember: names, dates, figures, quotations, specific studies or works, or recent or niche facts. Don't search for well-established conceptual explanations. Facts already cited with links earlier in this conversation were checked; rely on them rather than searching again.

When you use search results, cite each claim they support with a Markdown link named after the site's domain, right after the claim, like [en.wikipedia.org](https://en.wikipedia.org/wiki/Example). If a result contradicts what you believed, say so plainly.`;

/** Appended instead when the learner asked to check sources (search required). */
export const CHECK_SOURCES_INSTRUCTIONS = `## Checking facts

The user asked you to check your previous answer against sources. Search the web, then say plainly which of its claims the sources confirm, which they contradict (and what is right instead), and which you couldn't verify. Cite each checked claim with a Markdown link named after the site's domain, like [en.wikipedia.org](https://en.wikipedia.org/wiki/Example). Skip the tangents block.`;

/** The user message "Check sources" sends; the gate also recognizes it. */
export const CHECK_SOURCES_PREFIX = 'Check your last answer against sources';

/** The text of a "Check sources" message about `question` (clipped). */
export function checkSourcesMessage(question: string | null): string {
  const q = (question ?? '').replace(/\s+/g, ' ').trim();
  if (!q) return `${CHECK_SOURCES_PREFIX}.`;
  const clipped = q.length > 200 ? `${q.slice(0, 199)}…` : q;
  return `${CHECK_SOURCES_PREFIX}: "${clipped}"`;
}

/** Host name without `www.`, for source chips; the raw string if it isn't a URL. */
export function citationDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Only http(s) URLs are kept as sources (they become links). */
export function isCitableUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}
