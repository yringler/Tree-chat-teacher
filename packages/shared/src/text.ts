/**
 * `text` cut to at most `max` characters, ending in `…` when cut. Counts code
 * points, so an emoji or other surrogate pair is never split in half, and
 * drops the whitespace the cut leaves before the ellipsis.
 */
export function clip(text: string, max: number): string {
  // Fewer UTF-16 units than `max` means fewer code points too.
  if (text.length <= max) return text;
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars
    .slice(0, Math.max(0, max - 1))
    .join('')
    .trimEnd()}…`;
}

/**
 * Markdown as single-line plain text: code-fence lines, heading, quote and
 * list markers, emphasis and inline-code characters go (a code block's text
 * stays); links and images become their text, autolinks their URL;
 * whitespace collapses. With `max`, clipped (`clip`).
 */
export function plainText(markdown: string, options: { max?: number } = {}): string {
  const text = markdown
    .replace(/^[ \t]*(```|~~~)[^\n]*$/gm, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<((?:https?|mailto):[^>\s]*)>/g, '$1')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/gm, '')
    .replace(/[*`]+|~~/g, '')
    .replace(/(^|[^\p{L}\p{N}])_+/gu, '$1')
    .replace(/_+(?=[^\p{L}\p{N}]|$)/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return options.max === undefined ? text : clip(text, options.max);
}
