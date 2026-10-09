import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_QUOTE, PendingQuote, selectedMessageQuote } from './selection-ask';

/*
 * A tiny stand-in DOM (the tests run in Node): elements know their parent,
 * attributes and `closest('[data-node-id]')`; text nodes only their parent.
 */
interface FakeNode {
  nodeType: number;
  parentElement: FakeEl | null;
}
interface FakeEl extends FakeNode {
  attrs: Record<string, string>;
  getAttribute(name: string): string | null;
  closest(selector: string): FakeEl | null;
  contains(other: unknown): boolean;
}

function el(parent: FakeEl | null, attrs: Record<string, string> = {}): FakeEl {
  const self: FakeEl = {
    nodeType: 1,
    parentElement: parent,
    attrs,
    getAttribute: (name) => attrs[name] ?? null,
    closest: (selector) => {
      expect(selector).toBe('[data-node-id]');
      for (let e: FakeEl | null = self; e; e = e.parentElement) {
        if ('data-node-id' in e.attrs) return e;
      }
      return null;
    },
    contains: (other) => {
      for (let n = other as FakeNode | null; n; n = n.parentElement) if (n === self) return true;
      return false;
    },
  };
  return self;
}

const text = (parent: FakeEl): FakeNode => ({ nodeType: 3, parentElement: parent });

function selection(common: FakeNode | null, str: string, collapsed = false): Selection {
  return {
    isCollapsed: collapsed,
    rangeCount: common ? 1 : 0,
    getRangeAt: () => ({ commonAncestorContainer: common }),
    toString: () => str,
  } as unknown as Selection;
}

// page > container > message(n1) > body > p (text) ; container > message(n2)
const page = el(null);
const container = el(page);
const message = el(container, { 'data-node-id': 'n1' });
const body = el(message);
const para = el(body);
const other = el(container, { 'data-node-id': 'n2' });
const outside = el(page, { 'data-node-id': 'elsewhere' });
const c = container as unknown as Element;

describe('selectedMessageQuote', () => {
  it('names the message around the selection, with the trimmed text', () => {
    expect(selectedMessageQuote(c, selection(text(para), '  an owl hums \n'))).toEqual({
      nodeId: 'n1',
      quote: 'an owl hums',
    });
    // The range may end on an element rather than a text node.
    expect(selectedMessageQuote(c, selection(body, 'hums'))).toEqual({
      nodeId: 'n1',
      quote: 'hums',
    });
    expect(selectedMessageQuote(c, selection(other, 'x'))?.nodeId).toBe('n2');
  });

  it('caps the quote at the anchor quote limit', () => {
    const long = 'a'.repeat(MAX_QUOTE + 50);
    expect(selectedMessageQuote(c, selection(para, long))?.quote).toHaveLength(MAX_QUOTE);
  });

  it('offers nothing for no selection, blank text, or one outside a single message', () => {
    expect(selectedMessageQuote(c, null)).toBeNull();
    expect(selectedMessageQuote(null, selection(para, 'x'))).toBeNull();
    expect(selectedMessageQuote(c, selection(para, 'x', true))).toBeNull();
    expect(selectedMessageQuote(c, selection(null, 'x'))).toBeNull();
    expect(selectedMessageQuote(c, selection(para, '   '))).toBeNull();
    // Across two messages: the common ancestor is the container itself.
    expect(selectedMessageQuote(c, selection(container, 'x'))).toBeNull();
    // Outside the conversation.
    expect(selectedMessageQuote(c, selection(text(outside), 'x'))).toBeNull();
  });
});

describe('PendingQuote', () => {
  afterEach(() => vi.useRealTimers());

  it('shows at once and hides a moment after the selection goes', () => {
    vi.useFakeTimers();
    let current: { nodeId: string; quote: string } | null = { nodeId: 'n1', quote: 'owl' };
    const p = new PendingQuote(() => current);
    p.update();
    expect(p.value()).toEqual({ nodeId: 'n1', quote: 'owl' });
    current = null;
    p.update();
    // Still there for a tap on the action that collapsed the selection first.
    expect(p.value()).not.toBeNull();
    vi.advanceTimersByTime(399);
    expect(p.value()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(p.value()).toBeNull();
  });

  it('a new selection before the delay keeps it; clear drops it at once', () => {
    vi.useFakeTimers();
    let current: { nodeId: string; quote: string } | null = { nodeId: 'n1', quote: 'owl' };
    const p = new PendingQuote(() => current);
    p.update();
    current = null;
    p.update();
    current = { nodeId: 'n2', quote: 'lemon' };
    p.update();
    vi.advanceTimersByTime(1000);
    expect(p.value()?.quote).toBe('lemon');
    p.clear();
    expect(p.value()).toBeNull();
    p.destroy();
  });
});
