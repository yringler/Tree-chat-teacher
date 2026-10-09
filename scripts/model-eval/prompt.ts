/**
 * Builds the messages of one turn the way production does
 * (packages/core/src/context/render.ts, packages/providers/src/openai-compatible.ts):
 * the system prompt, then the branch path's turns; anchor quotes quoted into
 * the user turn (or, with anchorMode "system", appended to the system prompt
 * for comparison); consecutive same-role
 * messages merged; Anthropic models get `cache_control` breakpoints on the
 * system prompt and on the last message (prompt-cache.ts).
 */
import type { AnchorMode } from './types.ts';
import type { WireMessage } from './openrouter.ts';

/** Same text as ANCHOR_HEADING in packages/core/src/context/render.ts. */
export const ANCHOR_HEADING = '## The user branched off to focus on this excerpt';

/** One step of a branch path: the user's message, its anchor, and the answer it got. */
export interface PathStep {
  readonly question: string;
  readonly anchor?: string;
  /** Absent on the turn being asked. */
  readonly answer?: string;
}

/** Whether `model` caches only with explicit breakpoints (as `usesExplicitCacheControl`). */
export function usesExplicitCacheControl(model: string): boolean {
  return /^~?anthropic\//i.test(model.trim());
}

export function buildMessages(
  systemPrompt: string,
  path: readonly PathStep[],
  anchorMode: AnchorMode,
  model: string,
): WireMessage[] {
  const systemParts = [systemPrompt];
  const plain: { role: 'user' | 'assistant'; content: string }[] = [];
  const push = (role: 'user' | 'assistant', text: string): void => {
    const last = plain.at(-1);
    if (last && last.role === role) last.content = `${last.content}\n\n${text}`;
    else plain.push({ role, content: text });
  };
  for (const step of path) {
    if (step.anchor !== undefined && step.anchor.trim() !== '') {
      if (anchorMode === 'system') systemParts.push(`${ANCHOR_HEADING}\n\n${step.anchor}`);
      else push('user', `${ANCHOR_HEADING}\n\n<excerpt>\n${step.anchor}\n</excerpt>`);
    }
    push('user', step.question);
    if (step.answer !== undefined && step.answer.trim() !== '') push('assistant', step.answer);
  }
  const system = systemParts.join('\n\n');
  if (!usesExplicitCacheControl(model)) return [{ role: 'system', content: system }, ...plain];
  const marked: WireMessage[] = plain.map((m, i) =>
    i === plain.length - 1
      ? {
          role: m.role,
          content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }],
        }
      : m,
  );
  return [
    {
      role: 'system',
      content: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    },
    ...marked,
  ];
}
