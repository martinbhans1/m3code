# What is in the 5.6 GB state store

Measured 2026-09-09 against the live store (`~/.t3/userdata/state.sqlite`,
5,835 MB, plus a 63 MB write-ahead log). Nothing here has been deleted or
changed; this is an investigation and a recommendation.

## Where the space is

| | Size | What it is |
| --- | --- | --- |
| `orchestration_events` | 2,546 MB | The event log: the source of truth |
| ↳ its indexes | 530 MB | |
| `projection_thread_activities` | 1,764 MB | The conversation history the UI reads |
| ↳ its indexes | 290 MB | |
| `orchestration_command_receipts` | 405 MB | One row per command ever dispatched, with its index |
| Search (FTS, trigram, semantic) | 130 MB | |
| Messages, turns, everything else | ~170 MB | |

1.27 M events, 999 k activity rows, 1.27 M command receipts, 49 k messages,
1,166 conversations, going back to 2026-03-24.

**The dominant fact: one dataset is stored twice.** `thread.activity-appended`
events account for 1,662 MB of event payload, and the same payloads are copied
verbatim into `projection_thread_activities` (1,764 MB). Together that is about
3.4 of the 5.6 GB.

**It is accelerating**: 154 k events in June, 166 k in July, 637 k in August,
308 k in the first nine days of September - roughly 34 k events a day now, or
about 1 GB of store per month at the current mix.

## What is actually slow (and what is not)

The premise that a big store makes reads slow does not hold here. Measured
against the live 5.6 GB file: opening it is instant, the conversation list takes
2 ms, one conversation's recent activity 0 ms, full-text search 3 ms, trigram
search 1 ms. Everything hot is indexed and never touches the old rows.

What the size actually costs is disk, backup and copy time (a full copy takes
about two minutes), and write amplification - every activity row appended
maintains four indexes on a 1.7 GB table.

The real latency problem is elsewhere and is not about size:
`refreshThreadShellSummary` runs on **every** appended activity and re-reads all
of that conversation's messages, plans, activities and approvals to recompute
its counts. That is O(history) work per appended row, so a long conversation
gets slower the longer it runs, regardless of how big the store is. Worth its
own fix, separately from anything here.

## What could go, and what it would cost

Traced through every reader of each table.

**Free, no loss:**

- `idx_projection_thread_activities_thread_sequence` (50 MB) is a strict prefix
  of `idx_projection_thread_activities_thread_sequence_created_id`. SQLite can
  serve everything the short one serves from the long one. Dropping it reclaims
  the space and makes every activity append slightly cheaper.
- **Command receipts older than a few days** (up to ~400 MB with the index).
  They exist for one purpose: recognising a command that is retried, looked up
  by command id. Nothing else reads them, and nothing can retry a command from
  last April. There is no expiry today, so all 1.27 M are kept forever.

**Large, with a stated loss:**

- **`thread.activity-appended` events below the projection cursor** (~1.6 GB
  today, and the fastest-growing thing in the store). Each projector records how
  far it has applied, in `projection_state`; startup reads only events *after*
  that cursor, capped at 1,000 per projector. Nothing else reads old activity
  events - the only other reader of history is the usage report, which reads a
  different, tiny event type, and a replay endpoint no first-party client calls.
  - What you lose: the ability to rebuild the activity projection from the log
    for the pruned period. The conversation history itself is unaffected,
    because the UI reads the projection, which keeps every row.

**Do not touch:**

- `projection_thread_activities` is not a cache: it *is* the conversation
  history shown in the app. Pruning it deletes what you can read on screen.
- Search structures rebuild themselves - the text indexes are maintained by
  triggers off the messages table, and the semantic chunks are wiped and rebuilt
  whenever the model fingerprint changes. Not worth reclaiming 130 MB for.

## Recommendation

In order of return-per-risk:

1. Drop the redundant activity index. Instant, no behaviour change.
2. Add a retention rule for command receipts (7 days is generous - the real
   window is minutes).
3. Then decide on activity-event retention, which is the only one with a real
   trade-off: keeping 30 days of replayable log costs about 200 MB instead of
   1.6 GB and stops the main source of growth.
4. Reclaiming the freed pages needs a `VACUUM`, which rewrites the whole file
   and wants the app closed.

Steps 1-3 together reclaim roughly 2 GB, about a third of the store, without
touching a single row the app displays.

**Not done here, deliberately.** Migrations in this repo run automatically at
app start, so a destructive one would delete data the next time the app opened,
without anyone choosing the moment. If this is worth doing, it should be a
script that is run on purpose, with a dry run that prints what it would remove
and a backup taken first.

There is also a stale 596 MB copy of the store from 2026-06-30 sitting beside
the live one in `~/.t3/userdata`. It is nobody's backup strategy; it is just
there.
