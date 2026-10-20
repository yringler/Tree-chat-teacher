/*
 * What the message box offers once there is a reply, and the reply a
 * tangent sent from it starts at. One pure rule, so every composer starts a
 * tangent from the same reply and says the same thing about it.
 */
import type { ChatNode } from './domain.js';
import { REPLY_ACTION, TANGENT_ACTION } from './tangent-help.js';
import { splitTangents } from './tangents.js';
import { plainText } from './text.js';

/** A message as the rule reads it. */
export type ComposerMessage = Pick<ChatNode, 'id' | 'branchId' | 'role' | 'status'>;

/**
 * What the next message asks about, on a tangent made when it is sent: a
 * message on screen, about `quote` when words of it were selected.
 */
export interface ComposerLead {
  nodeId: string;
  quote: string | null;
}

/** What the rule needs to know. */
export interface ComposerFacts {
  /**
   * The messages on screen, root to leaf: the earlier threads' up to where
   * the open one starts, then the open thread's own (none in an empty tangent).
   */
  path: readonly ComposerMessage[];
  /** The open thread: the branch on screen. */
  branchId: string | null;
  /** The open thread is a tangent, not the main thread. */
  inTangent: boolean;
  /** The focused message (a click, `j`/`k`, a tangent opened at its start), anywhere on the path. */
  focusedId: string | null;
  /** What the box was aimed at: words from Ask about this, or a whole reply. */
  lead: ComposerLead | null;
}

/** A button that sends the box's text its own way, in place of Send. */
export interface ComposerSend {
  id: 'tangent' | 'next';
  label: string;
  /** What it is for (a tooltip). */
  hint: string;
  /** Filled, and sent with Enter; the other is outlined, and sent with Ctrl or Cmd+Enter. */
  primary: boolean;
}

/** Where the box's message goes, as its placeholder says. */
export type ComposerPlace = 'start' | 'lead' | 'emptyTangent' | 'tangent' | 'main';

/** The placeholder of every place but the start of a conversation, which each app words itself. */
export const COMPOSER_PLACEHOLDERS: Readonly<Record<Exclude<ComposerPlace, 'start'>, string>> = {
  lead: 'Ask about this…',
  emptyTangent: 'Ask your tangent…',
  tangent: 'Ask anything in this tangent…',
  main: 'Ask anything…',
};

/** How many characters of a message the composer names it by. */
const EXCERPT_CHARS = 60;

/**
 * The opening words of a message, as the composer names it: the message
 * it is aimed at, or the reply its tangent starts at. Plain text, without
 * a reply's tangents block.
 */
export function composerExcerpt(content: string): string {
  return plainText(splitTangents(content).body, { max: EXCERPT_CHARS });
}

export interface ComposerPlan {
  /** The reply a tangent from the box starts at; null: there is none, and the message continues the open thread. */
  target: string | null;
  /** The buttons in place of Send, always Tangent ↳ before Next ➜; none: a plain Send. */
  actions: readonly ComposerSend[];
  place: ComposerPlace;
  /**
   * The box names the target: it wasn't aimed at (a lead names itself) and
   * isn't the last message on screen, so it may not be the reply the reader
   * has in mind.
   */
  nameTarget: boolean;
}

/**
 * The composer's plan. The target is the first of:
 * 1. the lead;
 * 2. the focused message, if it is the open thread's own: a finished reply
 *    itself, and a question the finished reply that answers it, so a
 *    tangent opened at its start goes on from its first reply;
 * 3. the open thread's last message, if it is a reply that didn't fail.
 *
 * A message of an earlier thread is never the target unless the box is
 * aimed at it: it is there as the open thread's context.
 *
 * With no target there is only Send; with a lead, only Tangent ↳, since
 * words to ask about only go on a tangent; otherwise Tangent ↳ and Next ➜.
 * The filled one, which Enter sends, is Tangent ↳ on the main thread, where
 * a stray reply is read on every later turn, and Next ➜ inside a tangent,
 * where going on is the natural step: a reflexive Enter goes at most one
 * level down, and every level below that is chosen.
 */
export function composerPlan(f: ComposerFacts): ComposerPlan {
  const own = f.path.filter((m) => m.branchId === f.branchId);
  const target = f.lead?.nodeId ?? implicitTarget(own, f.focusedId);
  return {
    target,
    actions: target === null ? [] : sends(f),
    place: placeOf(f, own.length > 0),
    nameTarget: f.lead === null && target !== null && target !== f.path.at(-1)?.id,
  };
}

/**
 * The reply `b` puts on the box: the focused message's finished reply (a
 * question stands for the reply that answers it) anywhere on the path,
 * since aiming is how a tangent from an earlier thread is asked; else the
 * last message on screen, once it is a finished reply.
 */
export function replyToAim(
  path: readonly ComposerMessage[],
  focusedId: string | null,
): string | null {
  const focused = finishedReplyAt(
    path,
    path.findIndex((m) => m.id === focusedId),
  );
  if (focused) return focused.id;
  const last = path.at(-1);
  return last?.role === 'assistant' && last.status === 'complete' ? last.id : null;
}

function implicitTarget(own: readonly ComposerMessage[], focusedId: string | null): string | null {
  const focused = finishedReplyAt(
    own,
    own.findIndex((m) => m.id === focusedId),
  );
  if (focused) return focused.id;
  const last = own.at(-1);
  return last?.role === 'assistant' && last.status !== 'error' ? last.id : null;
}

/** The finished reply at `i`: the message itself, or for a question the next one. */
function finishedReplyAt(messages: readonly ComposerMessage[], i: number): ComposerMessage | null {
  const m = messages[i];
  const reply = m?.role === 'user' ? messages[i + 1] : m;
  return reply?.role === 'assistant' && reply.status === 'complete' ? reply : null;
}

function sends(f: ComposerFacts): ComposerSend[] {
  const tangent = (primary: boolean): ComposerSend => ({
    id: 'tangent',
    label: TANGENT_ACTION.label,
    hint: TANGENT_ACTION.hint,
    primary,
  });
  if (f.lead) return [tangent(true)];
  const hint = f.inTangent ? REPLY_ACTION.hintInTangent : REPLY_ACTION.hint;
  return [
    tangent(!f.inTangent),
    { id: 'next', label: REPLY_ACTION.label, hint, primary: f.inTangent },
  ];
}

function placeOf(f: ComposerFacts, ownMessages: boolean): ComposerPlace {
  if (f.path.length === 0) return 'start';
  if (f.lead) return 'lead';
  if (!f.inTangent) return 'main';
  return ownMessages ? 'tangent' : 'emptyTangent';
}
