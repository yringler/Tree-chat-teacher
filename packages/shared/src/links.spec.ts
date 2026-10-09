import { describe, expect, it } from 'vitest';
import {
  MAX_LINK_NOTE_CHARS,
  MAX_LINKS_PER_TREE,
  createLinkRequestSchema,
  treeBackupSchema,
  updateLinkRequestSchema,
} from './api.js';

const AT = '2026-10-01T00:00:00.000Z';

/** A one-message backup, as an older export (no `links`) wrote it. */
const backup = {
  format: 'tangent-tree-backup',
  version: 1,
  exportedAt: AT,
  tree: {
    id: 't',
    title: 'Primes',
    systemPrompt: null,
    trunkBranchId: 'b',
    createdAt: AT,
    updatedAt: AT,
  },
  branches: [
    {
      id: 'b',
      treeId: 't',
      parentBranchId: null,
      branchPointNodeId: null,
      contextMode: 'path',
      anchorQuote: null,
      title: 'Main thread',
      titleSource: 'default',
      isPrivate: false,
      providerId: 'openrouter',
      model: 'max',
      createdAt: AT,
      updatedAt: AT,
    },
  ],
  nodes: [
    {
      id: 'n1',
      treeId: 't',
      branchId: 'b',
      parentId: null,
      seq: 0,
      role: 'user',
      content: 'What is a prime?',
      status: 'complete',
      error: null,
      providerId: null,
      model: null,
      usage: null,
      createdAt: AT,
    },
  ],
};

const link = {
  id: 'l1',
  treeId: 't',
  sourceNodeId: 'n1',
  targetNodeId: 'n2',
  note: 'Same idea',
  origin: 'user',
  createdAt: AT,
  updatedAt: AT,
};

describe('link requests', () => {
  it('links two different messages, with an optional trimmed note', () => {
    expect(createLinkRequestSchema.parse({ fromNodeId: 'a', toNodeId: 'b' })).toEqual({
      fromNodeId: 'a',
      toNodeId: 'b',
    });
    expect(
      createLinkRequestSchema.parse({ fromNodeId: 'a', toNodeId: 'b', note: '  why  ' }).note,
    ).toBe('why');
    expect(
      createLinkRequestSchema.parse({ fromNodeId: 'a', toNodeId: 'b', note: null }).note,
    ).toBeNull();
  });

  it('refuses a message linked to itself', () => {
    const res = createLinkRequestSchema.safeParse({ fromNodeId: 'a', toNodeId: 'a' });
    expect(res.success).toBe(false);
    expect(res.error?.issues[0]?.path).toEqual(['toNodeId']);
  });

  it('refuses missing ids and notes over the limit (after trimming)', () => {
    expect(createLinkRequestSchema.safeParse({ fromNodeId: 'a' }).success).toBe(false);
    expect(createLinkRequestSchema.safeParse({ fromNodeId: '', toNodeId: 'b' }).success).toBe(
      false,
    );
    const long = 'x'.repeat(MAX_LINK_NOTE_CHARS + 1);
    expect(
      createLinkRequestSchema.safeParse({ fromNodeId: 'a', toNodeId: 'b', note: long }).success,
    ).toBe(false);
    const padded = ` ${'x'.repeat(MAX_LINK_NOTE_CHARS)} `;
    expect(
      createLinkRequestSchema.safeParse({ fromNodeId: 'a', toNodeId: 'b', note: padded }).success,
    ).toBe(true);
  });

  it('updates the note: a string (trimmed) or null, never absent', () => {
    expect(updateLinkRequestSchema.parse({ note: ' new ' })).toEqual({ note: 'new' });
    expect(updateLinkRequestSchema.parse({ note: null })).toEqual({ note: null });
    expect(updateLinkRequestSchema.safeParse({}).success).toBe(false);
    expect(
      updateLinkRequestSchema.safeParse({ note: 'x'.repeat(MAX_LINK_NOTE_CHARS + 1) }).success,
    ).toBe(false);
  });
});

describe('backups with links', () => {
  it('accepts a backup without links (made before they existed)', () => {
    const parsed = treeBackupSchema.parse(backup);
    expect(parsed.links).toBeUndefined();
  });

  it('accepts links, with or without an origin', () => {
    const { origin: _origin, ...noOrigin } = link;
    const parsed = treeBackupSchema.parse({ ...backup, links: [link, { ...noOrigin, id: 'l2' }] });
    expect(parsed.links).toEqual([link, { ...noOrigin, id: 'l2' }]);
  });

  it('refuses malformed links and more than a tree may hold', () => {
    expect(
      treeBackupSchema.safeParse({ ...backup, links: [{ ...link, origin: 'bot' }] }).success,
    ).toBe(false);
    expect(
      treeBackupSchema.safeParse({
        ...backup,
        links: [{ ...link, note: 'x'.repeat(MAX_LINK_NOTE_CHARS + 1) }],
      }).success,
    ).toBe(false);
    expect(
      treeBackupSchema.safeParse({ ...backup, links: [{ ...link, sourceNodeId: undefined }] })
        .success,
    ).toBe(false);
    const many = Array.from({ length: MAX_LINKS_PER_TREE + 1 }, (_, i) => ({
      ...link,
      id: `l${i}`,
    }));
    expect(treeBackupSchema.safeParse({ ...backup, links: many }).success).toBe(false);
  });
});
