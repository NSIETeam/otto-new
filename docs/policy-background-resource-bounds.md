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

## Resumable collection cycle

`policyCollectionCycle.ts` checkpoints work inside the existing recurring task;
it is not another scheduler. The database schema is unchanged. New encrypted
records (`collection:progress` and per-source `collection-candidates:*`) are
additive, and the original policy documents, diagnoses, notices and complete
`collection:status.at` remain intact.

Each tick stops after four local keyset pages, two source attempts, or one model
step. A page reads at most 32 keys and one bounded payload at a time. Collection
retains at most 16 lightweight recheck candidates per configured source: the
original 12 listing links can overlap these candidates, leaving the original
four eligible rechecks. This does not expand network rechecks. Source order still
uses oldest `checkedAt` first. The official allowlists, national/provincial sources,
12/6 listing limits, four related documents, attachment limits and 30-second
per-source deadline remain unchanged.

Pending extraction holds at most eight IDs, checked before retaining an ID; it
never accumulates all fetched bodies and then slices them. A full cycle can
interpret at most those eight candidates. Enablement is checked again immediately
before provider dispatch. Automated recommendations do not call the legacy
whole-workspace `state()` method: they retain only the latest 500 lightweight IDs
for one enterprise, read the selected document when needed, and keep the original
eight-attempt and 90-active-second enterprise limits across ticks. They reuse the
manual recommendation lease and existing account/tenant/profile-generation,
source, daily quota and post-model validation gates.

The active-work budget is 600 seconds per Shanghai 03:00/18:30 slot, including
tick planning/checkpoint overhead; idle time between ticks is not charged.
Source/model time is reserved durably before dispatch. Successful units reconcile
actual elapsed time; an interrupted local page replays its old cursor without
refunding unknown spending. Unknown source/model outcomes preserve their
reservation and enter visible `needs-review`, never an automatic paid retry.
An in-flight configuration change also requires review. A tick crossing a slot
boundary is conservatively charged in full in the new slot as well.

Budget exhaustion is `awaiting-next-slot`, not successful completion. The next
slot first continues the same cycle, retaining source positions, recheck choices,
extraction IDs and enterprise attempt/time budgets. Only a genuinely completed
cycle updates `collection:status.at`; completing it does not start another cycle
in the same slot. The existing state error/status surface displays pending,
budget-waiting and review reasons. Operators must reconcile unknown provider
outcomes and the retained reservation before any separately authorized recovery;
deleting the progress row is not a supported budget reset or reconciliation.

Failed-source reconciliation is one paged cache traversal, not a full scan for
every failing source. Source health fails closed immediately in notifications,
analysis and the manual state view even before that traversal reaches an old
document. Existing snapshot pruning reads one page of at most 32 **keys**, never
all historical bodies. Normal 20-version retention is unchanged; legacy excess
is only pruned when 20 observed higher versions prove an entry is outside that
retention window. Unobserved history is not bulk-deleted.

## Limits and verification

There is no startup bulk import or policy schema migration. These are application
work/memory bounds, not a process RSS or cgroup guarantee for a 1.6 GiB server.
A single slow synchronous operation can overrun its cooperative deadline; actual
spending is retained and an overrun is reviewable rather than hidden. Legacy
manual full-text `state()` and inbox APIs remain compatible and are **not** claimed
to be safe for arbitrary-size old histories. No automatic loss-prone data migration
or global document/notice deletion is introduced.

Key regressions use 2,000 synthetic large public documents, 70 enterprise
mailboxes, 100-watch mailboxes, multiple enterprises, a 600-second synthetic
active-work clock, real encrypted SQLite storage, and PostgreSQL query contracts.
They check maximum read counts, lightweight retained state, fair continuation,
source/model limits, partial-completion timestamps, deadline/change event and
read-acknowledgement replay, lease contention, source failure and disablement
races, byte-limit rollback, and unknown-call non-replay. No production data or
live policy/model calls are used. Query-contract tests are not a substitute for
the separate real PostgreSQL CI lane.
