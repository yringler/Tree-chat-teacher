# Child sexual abuse material and threats of violence

What the operator does on learning that a share link holds apparent child sexual abuse material (CSAM), or a credible threat or plan of violence. A US provider that has actual knowledge of apparent CSAM must report it to NCMEC's CyberTipline (18 U.S.C. §2258A) and preserve what it reported for a year. Scanning for it is not required. Commands run from `apps/worker` after `npx wrangler login` with access to the account that holds the database `tangent`.

Do the steps in order and don't skip the hold: deleting first destroys the evidence.

## 1. Find the share

The link is `/s/<token>`. Look up its id and owner:

```bash
npx wrangler d1 execute tangent --remote --command "SELECT id, account_id, tree_id, revoked_at FROM shares WHERE token = '<token>'"
```

`account_id` is `u_<userId>`.

## 2. Preserve it

Place a legal hold before anything else. Signed in as an admin, open `/admin/` and run this in the browser console (the admin page has no button for it yet):

```js
await (
  await fetch('/api/admin/shares/<shareId>/hold', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'csam', notes: 'How it was found' }),
  })
).json();
```

Use `violent_or_illegal` for violence, `law_enforcement` for a request from the police. The reply is the hold's metadata; note its `id`. The hold copies the share row, its snapshot, a backup of the whole conversation, the owner's user row and their sessions' IP addresses and browsers. Revoking, deleting the conversation or the account leaves it in place. `GET /api/admin/holds` lists every hold.

## 3. Take it down

On the admin page, find the owner (search by email, or the user id from step 1) and **Revoke** the share. To stop them publishing anything else, suspend their sharing:

```bash
npx wrangler d1 execute tangent --remote --command "UPDATE auth_users SET sharing_suspended = 1 WHERE id = '<userId>'"
```

Their other links stop opening at once.

## 4. Look only as far as you must

Only the one admin handling the case reads the hold. For text, the length and a skim are usually enough to confirm what was reported; don't open it more than the report needs. Keep any exported copy on an encrypted disk and delete it once the report is filed.

List what the hold has:

```bash
npx wrangler d1 execute tangent --remote --command "SELECT kind, chunk, length(data) FROM legal_hold_items WHERE hold_id = '<holdId>' ORDER BY kind, chunk"
```

Export one kind (`share`, `snapshot`, `tree_backup`, `user` or `sessions`) and join its chunks into one JSON file:

```bash
npx wrangler d1 execute tangent --remote --json --command "SELECT data FROM legal_hold_items WHERE hold_id = '<holdId>' AND kind = 'snapshot' ORDER BY chunk" \
  | jq -j '.[0].results[].data' > snapshot.json
```

## 5. Report it

- **CSAM:** file a report with NCMEC's CyberTipline (<https://report.cybertip.org/>), as the registered electronic service provider if you have registered ([LEGAL.md](../LEGAL.md) §11). Give the share's content, the time it was shared, and the account's email, IP addresses and sign-in times from the hold.
- **Imminent threat of violence:** report it to the FBI at <https://tips.fbi.gov/> (or call local emergency services when someone is in danger now).

Then record the report on the hold, with the number you were given:

```js
await (
  await fetch('/api/admin/holds/<holdId>/external-report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'ncmec', reference: '<report number>' }),
  })
).json();
```

`kind` is `ncmec` or `law_enforcement`. From then on the hold can't be released for a year.

## 6. Close the account, without telling the user why

Don't tell the user what was found or that it was reported: it can interfere with an investigation. Account termination isn't built into the admin page yet; with the hold in place, the sharing suspension of step 3 keeps them from publishing.

## 7. Release the hold

When the evidence is no longer needed (at least a year after the report, or when law enforcement says so), release it: the copies are deleted, and the hold's record and audit trail stay.

```js
await (
  await fetch('/api/admin/holds/<holdId>/release', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes: 'Why it is released' }),
  })
).json();
```

A release within a year of a recorded report is refused.
