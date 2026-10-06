import '@angular/compiler'; // JIT: @tangent/web-shared's components, imported with relatedLinks.
import { indexLinks } from '@tangent/core/links';
import { indexTree } from '@tangent/core/tree';
import {
  DEFAULT_BRANCH_TITLE_PREFIX,
  TRUNK_TITLE,
  type Branch,
  type ChatNode,
  type NodeLink,
} from '@tangent/shared';
import { relatedLinks } from '@tangent/web-shared';
import { describe, expect, it } from 'vitest';
import { connectedLabel, connectionTitleOf, learnConnections, LESSON_CRUMB } from './connections';

const T = '2026-01-01T00:00:00.000Z';

function branch(id: string, over: Partial<Branch> = {}): Branch {
  return {
    id,
    treeId: 't1',
    parentBranchId: null,
    branchPointNodeId: null,
    contextMode: 'path',
    anchorQuote: null,
    title: id,
    titleSource: 'default',
    isPrivate: false,
    providerId: 'openrouter',
    model: 'smart-model',
    funding: 'own-key',
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

function node(id: string, branchId: string, seq: number, content: string): ChatNode {
  return {
    id,
    treeId: 't1',
    branchId,
    parentId: null,
    seq,
    role: seq % 2 === 0 ? 'user' : 'assistant',
    content,
    status: 'complete',
    error: null,
    providerId: null,
    model: null,
    usage: null,
    createdAt: T,
  };
}

function link(id: string, sourceNodeId: string, targetNodeId: string, note: string | null) {
  const l: NodeLink = {
    id,
    treeId: 't1',
    sourceNodeId,
    targetNodeId,
    note,
    origin: 'user',
    createdAt: T,
    updatedAt: T,
  };
  return l;
}

const trunk = branch('trunk', { title: TRUNK_TITLE });
const side = branch('side', {
  parentBranchId: 'trunk',
  branchPointNodeId: 'a1',
  title: `${DEFAULT_BRANCH_TITLE_PREFIX}Why waves`,
});
const index = indexTree(
  [trunk, side],
  [
    node('u1', 'trunk', 0, 'What is light?'),
    node('a1', 'trunk', 1, 'Light is a **wave**.'),
    node('s1', 'side', 0, 'Why a wave?'),
    node('s2', 'side', 1, 'It interferes.'),
  ],
);

describe('connectionTitleOf', () => {
  it('names the main thread "Lesson" and side questions in Learn’s words', () => {
    expect(connectionTitleOf(trunk)).toBe(LESSON_CRUMB);
    expect(connectionTitleOf(side)).toBe('Why waves');
  });
});

describe('connectedLabel', () => {
  it('counts the connected messages', () => {
    expect(connectedLabel(1)).toBe('Connected to 1 message');
    expect(connectedLabel(3)).toBe('Connected to 3 messages');
  });
});

describe('learnConnections', () => {
  const byNode = indexLinks([link('l1', 'a1', 's1', 'Same idea'), link('l2', 'a1', 's2', null)]);

  it('shows a side question’s first message as the side question', () => {
    const [toHead, toReply] = learnConnections(
      relatedLinks(index, byNode, 'a1', connectionTitleOf),
    );
    expect(toHead?.title).toBe('Side question: Why waves');
    expect(toHead?.crumbs).toBe(LESSON_CRUMB);
    expect(toHead?.tooltip).toBe('Lesson\nSide question: Why waves\nSame idea');
    // Any other message keeps its snippet, under its breadcrumb.
    expect(toReply?.title).toBe('It interferes.');
    expect(toReply?.crumbs).toBe('Lesson › Why waves');
  });

  it('shows the other end from either side', () => {
    const [back] = learnConnections(relatedLinks(index, byNode, 's1', connectionTitleOf));
    expect(back?.nodeId).toBe('a1');
    expect(back?.title).toBe('Light is a wave.');
    expect(back?.crumbs).toBe(LESSON_CRUMB);
  });
});
