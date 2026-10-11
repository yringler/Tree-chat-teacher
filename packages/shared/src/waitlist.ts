import { z } from './zod.js';

/**
 * The waitlist: while sign-ups are closed (`MAX_USERS`), the login page
 * offers a form that records an email address, and the admin page invites
 * people from it once there is room. Joining needs a Turnstile pass, like a
 * magic link.
 */

/** Longest email address (RFC 5321's path limit), as Better Auth allows. */
const EMAIL_MAX = 320;

const email = z.email().max(EMAIL_MAX);

/** `POST /api/waitlist` (public, same-origin): 204 whether or not the address was already on it. */
export const joinWaitlistRequestSchema = z.object({
  email,
  /** The Turnstile widget's token. */
  captchaToken: z.string().min(1).max(2048),
});
export type JoinWaitlistRequest = z.infer<typeof joinWaitlistRequestSchema>;

/** Most entries `GET /api/admin/waitlist` lists, oldest first. */
export const ADMIN_WAITLIST_LIMIT = 1000;

/** Most addresses one `POST /api/admin/waitlist/invite` emails. */
export const WAITLIST_INVITE_MAX = 100;

export interface AdminWaitlistEntry {
  email: string;
  /** ISO time the address joined. */
  createdAt: string;
  /** ISO time the last invite was sent; null = not invited yet. */
  invitedAt: string | null;
}

/** `GET /api/admin/waitlist`. */
export interface AdminWaitlistResponse {
  /** Oldest first, at most ADMIN_WAITLIST_LIMIT. */
  entries: AdminWaitlistEntry[];
  /** Everyone on the waitlist, listed or not. */
  total: number;
  /** Signed-up users now. */
  users: number;
  /** `MAX_USERS`; null = no cap (sign-ups are open). */
  maxUsers: number | null;
}

/** `POST /api/admin/waitlist/invite`: emails each address a sign-in link to the app. */
export const adminWaitlistInviteRequestSchema = z.object({
  emails: z.array(email).min(1).max(WAITLIST_INVITE_MAX),
});
export type AdminWaitlistInviteRequest = z.infer<typeof adminWaitlistInviteRequestSchema>;

export interface AdminWaitlistInviteResponse {
  /** Addresses on the waitlist that were emailed (others are skipped). */
  invited: number;
}
