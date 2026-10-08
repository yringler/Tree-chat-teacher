import { renderMarkdown } from '@tangent/render';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownService } from './markdown.service';

vi.mock('@tangent/render', async (original) => {
  const actual = await original<typeof import('@tangent/render')>();
  return { ...actual, renderMarkdown: vi.fn(actual.renderMarkdown) };
});

const rendered = vi.mocked(renderMarkdown);

describe('MarkdownService', () => {
  beforeEach(() => {
    rendered.mockClear();
  });

  it('renders with the shared renderer and caches the result', () => {
    const md = new MarkdownService();
    expect(md.render('**hi**')).toBe('<p><strong>hi</strong></p>\n');
    expect(md.render('**hi**')).toBe('<p><strong>hi</strong></p>\n');
    expect(rendered).toHaveBeenCalledTimes(1);
  });

  it('does not cache streaming text', () => {
    const md = new MarkdownService();
    md.render('partial', false);
    md.render('partial', false);
    expect(rendered).toHaveBeenCalledTimes(2);
  });

  it('evicts the least recently used entry, not the oldest one', () => {
    const md = new MarkdownService();
    for (let i = 0; i < 300; i++) md.render(`message ${i}`);
    md.render('message 0'); // a hit: now the most recently used
    md.render('message 300'); // full: evicts message 1
    rendered.mockClear();
    md.render('message 0');
    expect(rendered).not.toHaveBeenCalled();
    md.render('message 1');
    expect(rendered).toHaveBeenCalledTimes(1);
  });

  it('falls back to escaped text when rendering throws', () => {
    const md = new MarkdownService();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    rendered.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(md.render('<b>x</b>')).toBe('<p class="plain">&lt;b&gt;x&lt;/b&gt;</p>');
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
