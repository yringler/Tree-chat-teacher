import type { ChatMessage, ContextPlan, RenderedPrompt, SummaryRequest } from '@tangent/shared';

export interface RenderOptions {
  supportsSystemPrompt: boolean;
}

export const SUMMARY_HEADING = '## Summary of the earlier conversation';
export const ANCHOR_HEADING = '## The user branched off to focus on this excerpt';
export const CONTINUATION_MESSAGE = '(Conversation continues.)';

/**
 * Plan → provider-agnostic prompt.
 * - system: tree system prompt, system nodes, summaries and anchor quotes, in
 *   segment order, as labelled sections;
 * - messages: ancestor + branch message segments in order; consecutive
 *   same-role messages are merged; a leading assistant message gets a
 *   synthetic user message in front so the list starts with `user`;
 * - when `supportsSystemPrompt` is false the system text is prepended to the
 *   first user message.
 * Pending/failed summaries are omitted.
 */
export function renderPlan(plan: ContextPlan, options: RenderOptions): RenderedPrompt {
  const systemParts: string[] = [];
  const messages: ChatMessage[] = [];
  for (const seg of plan.segments) {
    switch (seg.kind) {
      case 'system':
        if (seg.text.trim() !== '') systemParts.push(seg.text);
        break;
      case 'summary':
        if (seg.status === 'ready' && seg.text !== null)
          systemParts.push(`${SUMMARY_HEADING}\n\n${seg.text}`);
        break;
      case 'anchor':
        systemParts.push(`${ANCHOR_HEADING}\n\n${seg.text}`);
        break;
      case 'ancestor':
      case 'branch': {
        if (seg.text.trim() === '') break;
        const last = messages.at(-1);
        if (last && last.role === seg.role) last.content = `${last.content}\n\n${seg.text}`;
        else messages.push({ role: seg.role, content: seg.text });
        break;
      }
    }
  }

  if (messages[0]?.role === 'assistant')
    messages.unshift({ role: 'user', content: CONTINUATION_MESSAGE });

  const system = systemParts.length > 0 ? systemParts.join('\n\n') : null;
  if (options.supportsSystemPrompt || system === null) return { system, messages };

  const first = messages[0];
  if (first) first.content = `${system}\n\n${first.content}`;
  else messages.push({ role: 'user', content: system });
  return { system: null, messages };
}

function serializeTranscript(messages: readonly ChatMessage[]): string {
  return messages
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n');
}

const SUMMARY_SYSTEM =
  'You write faithful, concise summaries of conversations between a user and an AI assistant. ' +
  'The summary replaces the conversation as context when it continues in a new thread, so it must stand on its own. ' +
  'Preserve key facts, decisions, conclusions, open questions and exact code identifiers, names and numbers. ' +
  'Bullet points are fine. Do not invent anything that is not in the conversation. ' +
  'Keep it under about 300 words and output only the summary.';

/** Prompt used to generate a branch/compaction summary for `request`. */
export function buildSummaryPrompt(request: SummaryRequest): RenderedPrompt {
  let system = SUMMARY_SYSTEM;
  let instruction = 'Summarize the conversation above so it can be continued in a new thread.';
  if (request.focus !== null && request.focus.trim() !== '') {
    system +=
      ' The user is branching off to focus on a specific excerpt; emphasize what is relevant to it ' +
      'while keeping the context needed to understand it.';
    instruction += `\n\nThe new thread focuses on this excerpt:\n\n<excerpt>\n${request.focus}\n</excerpt>`;
  }
  const content = `<conversation>\n${serializeTranscript(request.transcript)}\n</conversation>\n\n${instruction}`;
  return { system, messages: [{ role: 'user', content }] };
}

const TITLE_MESSAGE_CHARS = 2000;

/** Prompt used to auto-title a branch from its first messages. */
export function buildTitlePrompt(messages: readonly ChatMessage[]): RenderedPrompt {
  const clipped = messages.map((m) => ({
    role: m.role,
    content:
      m.content.length > TITLE_MESSAGE_CHARS
        ? `${m.content.slice(0, TITLE_MESSAGE_CHARS)}…`
        : m.content,
  }));
  return {
    system:
      'You name conversations. Reply with only a short title: 2–6 words, no quotes, no trailing punctuation.',
    messages: [
      {
        role: 'user',
        content:
          `<conversation>\n${serializeTranscript(clipped)}\n</conversation>\n\n` +
          'Write a 2–6 word title for this conversation. Do not use quotes. Output only the title.',
      },
    ],
  };
}

const MAX_TITLE_CHARS = 80;
const QUOTES = /^["'“”‘’«»„]+|["'“”‘’«»„]+$/gu;
const TRAILING_PUNCTUATION = /[\s.,;:!?…。、，！？-]+$/u;

function cleanLine(line: string): string {
  let s = line.trim();
  s = s.replace(/^#+\s*/, '');
  s = s.replace(/[*`]/g, '');
  s = s.replace(/(^|\s)_+/g, '$1').replace(/_+(?=\s|$)/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^title\s*:\s*/i, '');
  let previous: string;
  do {
    previous = s;
    s = s.replace(QUOTES, '').trim().replace(TRAILING_PUNCTUATION, '');
  } while (s !== previous);
  return s;
}

/** Cleans a model-produced title: one line, no quotes/markdown, <= 80 chars. null if empty. */
export function cleanTitle(raw: string): string | null {
  for (const line of raw.split(/\r?\n/)) {
    let s = cleanLine(line);
    if (s === '') continue;
    if (s.length > MAX_TITLE_CHARS) {
      const cut = s.slice(0, MAX_TITLE_CHARS + 1);
      const space = cut.lastIndexOf(' ');
      s = space > 0 ? cut.slice(0, space) : s.slice(0, MAX_TITLE_CHARS);
      s = s.replace(TRAILING_PUNCTUATION, '');
    }
    if (s !== '') return s;
  }
  return null;
}
