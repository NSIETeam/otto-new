# Policy background resource bounds

## Encrypted store and cached notifications

Policy store background consumers use keyset pages (at most 32 keys) and
database-side payload length checks before encrypted values cross into JavaScript.
SQLite, PostgreSQL and memory stores implement the same cursor contract. Atomic
updates can check both the existing and resulting payload; a failed check rolls
back without changing the stored history.

The notification task processes at most 32 mailboxes and 128 watched document IDs
per tick, with a cooperative five-second elapsed-work budget. A mailbox has at
most 100 supported watches. It reads only watched IDs after checking current
account, tenant and enterprise enablement, and checks authorization again before
writing an event. There is no model call or remote fetch in this task.

`notification:progress` persists the last completed mailbox and an in-progress
watch cursor. The next tick resumes that cursor; a completed traversal wraps to
observe revisions and newly added watches. A service single-flight and renewable
30-second store lease prevent concurrent traversal. Event IDs and `readAt` remain
in the original atomic mailbox, so replay after a write/checkpoint crash does not
create duplicate events or lose read acknowledgements. A partial traversal never
advances `lastCompletedAt`.

The legacy single-row mailbox is **not** silently truncated, deleted or migrated.
The background limit is 1 MiB of stored payload, including encryption envelope
overhead on encrypted stores. Oversized mailboxes, associated documents or
workspaces, unsupported legacy watch counts, and an update that would cross the
limit produce `notification:health:<mailbox-key>` with `needs-maintenance`.
The existing policy state `lastError` exposes that condition to the user. Other
mailboxes continue, but the traversal does not claim a fully successful sweep.
The original history, event IDs and read acknowledgements remain unchanged.

This guard does not make arbitrary-size **manual** legacy inbox reads safe. They
remain available for compatibility; a future separately reviewed, lossless
storage migration is required to remove the single-row legacy limit. The
five-second budget is cooperative between local operations, not an OS CPU/RSS
limit or a guarantee that one unusually slow database operation completes on time.

## Collection follow-up

The store primitives above also support a separately reviewed resumable collection
cycle. They must not be interpreted as proof that the legacy collection path is
already bounded: that path is being replaced independently. National source
coverage, manual full-text access and stored policy history must be preserved.
