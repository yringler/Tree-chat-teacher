import { describe, expect, it } from 'vitest';
import { CONDENSED_REPLY_MARKER } from '../../src/context/render.js';
import { createMemoryRepositories } from '../../src/memory/memory-repositories.js';
import { ChatService, DEFAULT_CHAT_SETTINGS } from '../../src/services/chat-service.js';
import type { GenerationProfile } from '../../src/services/profile.js';
import { registryOf, ScriptedProvider, send } from './helpers.js';

/** A reply well over `CONDENSE_REPLIES_ABOVE_TOKENS`. */
const CHAPTER = 'A chapter-length reply. '.repeat(400);

/**
 * A trunk reply of chapter length, a tangent from it, and a tangent from the
 * tangent's reply: the trunk reply is two levels up from the second tangent.
 */
async function setup(profile: GenerationProfile) {
  const repos = createMemoryRepositories();
  const provider = new ScriptedProvider();
  let n = 0;
  const chat = new ChatService({
    repos,
    providers: registryOf(provider),
    profile,
    defaultSystemPrompt: 'TUTOR',
    settings: { ...DEFAULT_CHAT_SETTINGS, autoTitle: false },
    newId: () => `id${++n}`,
  });
  const { tree } = await chat.createTree({});
  provider.chatText = CHAPTER;
  const root = await send(chat, tree.trunkBranchId, 'teach me');
  provider.chatText = null;
  const child = await chat.createBranch({
    fromNodeId: root.begin.assistantNode.id,
    contextMode: 'path',
  });
  const reply = await send(chat, child.id, 'why?');
  const grandchild = await chat.createBranch({
    fromNodeId: reply.begin.assistantNode.id,
    contextMode: 'path',
  });
  return { repos, provider, chat, child, grandchild };
}

const sentText = (provider: ScriptedProvider) =>
  JSON.stringify(provider.chatCalls().at(-1)!.messages);

describe('condensing long replies in Learn', () => {
  it('sends the tangent a long reply starts from whole', async () => {
    const { provider } = await setup({ kind: 'learn', customPrompt: true });
    expect(provider.summaryCalls()).toHaveLength(0);
    expect(sentText(provider)).toContain(CHAPTER.trim());
  });

  it('condenses it two levels down, once, and reuses the summary', async () => {
    const { repos, provider, chat, grandchild } = await setup({
      kind: 'learn',
      customPrompt: true,
    });
    const first = await send(chat, grandchild.id, 'deeper');
    expect(first.events).toContainEqual({
      type: 'status',
      message: 'Condensing an earlier reply…',
    });
    expect(provider.summaryCalls()).toHaveLength(1);
    expect(provider.summaryCalls()[0]!.usageTag).toMatchObject({ purpose: 'summary' });
    expect(sentText(provider)).toContain(CONDENSED_REPLY_MARKER);
    expect(sentText(provider)).not.toContain(CHAPTER.trim());
    expect(repos.dump().summaries.size).toBe(1);

    await send(chat, grandchild.id, 'and more');
    expect(provider.summaryCalls()).toHaveLength(1);
    expect(sentText(provider)).toContain(CONDENSED_REPLY_MARKER);
  });

  it('uses a summary cut off at its cap for the send, without caching it', async () => {
    const { repos, provider, chat, grandchild } = await setup({
      kind: 'learn',
      customPrompt: true,
    });
    provider.summaryStopReason = 'length';
    await send(chat, grandchild.id, 'deeper');
    expect(sentText(provider)).toContain(CONDENSED_REPLY_MARKER);
    expect(repos.dump().summaries.size).toBe(0);
    await send(chat, grandchild.id, 'again');
    expect(provider.summaryCalls()).toHaveLength(2);
  });

  it('sends the reply whole when its summary fails', async () => {
    const { provider, chat, grandchild } = await setup({ kind: 'learn', customPrompt: true });
    provider.summaryText = '';
    await send(chat, grandchild.id, 'deeper');
    expect(provider.summaryCalls()).toHaveLength(1);
    expect(sentText(provider)).toContain(CHAPTER.trim());
  });

  it('leaves power’s context as it is', async () => {
    const { provider, chat, grandchild } = await setup({ kind: 'power' });
    await send(chat, grandchild.id, 'deeper');
    expect(provider.summaryCalls()).toHaveLength(0);
    expect(sentText(provider)).toContain(CHAPTER.trim());
  });
});
