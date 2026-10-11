# Child sexual abuse material and threats of violence

What the operator does on learning that a share link holds apparent child sexual abuse material (CSAM), or a credible threat or plan of violence. A US provider that has actual knowledge of apparent CSAM must report it to NCMEC's CyberTipline (18 U.S.C. §2258A) and preserve what it reported for a year. Scanning for it is not required. Commands run from `apps/worker` after `npx wrangler login` with access to the account that holds the database `tangent`.

Do the steps in order and don't skip the hold: deleting first destroys the evidence.

## 1. Find the share

A report from the share page is in the **Reports** queue on the admin page (`/admin/`), with the share's state, its owner's email and id, and whether it is already held: a CSAM or violence report places a hold and emails you by itself. Otherwise the link is `/s/<token>`; look up its id and owner:

```bash
npx wrangler d1 execute tangent --remote --command "SELECT id, account_id, tree_id, revoked_at FROM shares WHERE token = '<token>'"
```

`account_id` is `u_<userId>`.

## 2. Preserve it

Place a legal hold before anything else, unless the queue already shows the report **held** (the **Legal holds** list has it too). For a report that isn't held, **Hold** on its row in the queue places one (CSAM and violence reports get their own reason, others `other`). For a share nobody reported, signed in as an admin, open `/admin/` and run this in the browser console:

```js
await (
  await fetch('/api/admin/shares/<shareId>/hold', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'csam', notes: 'How it was found' }),
  })
).json();
```

Use `violent_or_illegal` for violence, `law_enforcement` for a request from the police. The hold copies the share row, its snapshot, a backup of the whole conversation, the owner's user row and their sessions' IP addresses and browsers. Revoking, deleting the conversation or the account leaves it in place.

## 3. Take it down

In the queue, **Remove** the report (or, for a share nobody reported, find the owner under **Users**, open **Shares** and **Remove** it there). The link stays down for good. To stop the owner publishing anything else, tick **Sharing suspended** on their row: their other links stop opening at once.

## 4. Look only as far as you must

Only the one admin handling the case reads the hold. For text, the length and a skim are usually enough to confirm what was reported; don't open it more than the report needs. **Review** (in the queue, the user's shares or the holds list) opens the conversation at `/admin/review/<shareId>` in a new tab, from the hold's copy once the share is gone; every opening is recorded in the audit log. Keep any exported copy on an encrypted disk and delete it once the report is filed.

For the rest of the hold (the account, its sessions, the whole conversation), list what it has:

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

Then record the report on the hold: in **Legal holds**, pick **NCMEC** or **Law enforcement**, enter the number you were given and **Record**. From then on the hold can't be released for a year.

## 6. Close the account, without telling the user why

Don't tell the user what was found or that it was reported: it can interfere with an investigation. Account termination isn't built into the admin page yet; with the hold in place, the sharing suspension of step 3 keeps them from publishing.

## 7. Release the hold

When the evidence is no longer needed (at least a year after the report, or when law enforcement says so), **Release** it in **Legal holds**: the copies are deleted, and the hold's record and audit trail stay. A release within a year of a recorded report is refused.
