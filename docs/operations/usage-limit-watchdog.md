# Usage-limit watchdog

Restarts work that a usage limit stopped, from a process that is not itself
subject to the usage limit.

## Why it is not a scheduled agent

A conversation that supervises other conversations dies of the same cause as the
ones it supervises: when the account hits its limit, the supervisor's own turn
fails too, and a recurring check scheduled inside that session only fires while
the session is alive and idle. So when the limit lifts, nothing restarts. The
watchdog therefore has to live outside the budget entirely - an ordinary local
process, started by the OS scheduler, sharing no runtime with the app.

## How it works

Every five minutes `scripts/usage-limit-watchdog.ts scan` runs one cycle:

1. **Observe** (`lib/watchdog-observe.ts`) - opens `state.sqlite` read-only and
   collects every unarchived conversation whose newest turn ended in `error`,
   together with its last runtime error, its session status, and when anything
   last happened in it.
2. **Decide** (`lib/watchdog-decide.ts`) - pure, and where all the safety lives.
   A conversation is a candidate only if its own last failure was a usage-limit
   message with a reset time that parses (`lib/usage-limit-signal.ts`) and that
   has since passed. Everything else - a genuine failure, a finished
   conversation, one someone has replied to since, one already running, one
   waiting on an approval or a question, one stalled more than 12 hours ago - is
   recorded and left alone.
3. **Act** (`lib/watchdog-nudge.ts`) - opens an authenticated WebSocket to the
   running app and dispatches an ordinary `thread.turn.start`, the same command
   the composer sends. The bearer token is minted headlessly from the bundled
   `t3 auth session issue` CLI and cached until shortly before it expires.
4. **Re-arm the wake** - see below.

Supervising conversations (those in the orchestrator project) are woken before
the conversations they supervise, so supervision restarts first.

## What stops it spending in a loop

- **One conversation per scan, per account.** The next conversation on that
  account waits until the woken one visibly moved, so a limit that had not
  really lifted costs one nudge rather than five. Separate provider instances
  are separate budgets, so they recover in parallel rather than queueing behind
  each other.
- **Two attempts per conversation per reset window**, and never twice inside
  twenty minutes.
- **Rolling caps**: eight nudges per six hours, twenty per day, counted from the
  on-disk ledger, so a killed process does not reset the count. These are global
  across accounts.
- **Refusals**: if the app is not running, if more than twelve conversations look
  stalled at once, or if the reset time cannot be read out of the message, it
  does nothing and says why.

## Waking the machine

A watchdog that only runs while the machine is awake still loses the night if
the machine sleeps at 02:00 and the limit lifts at 03:40. So there are two
scheduled tasks:

| Task | When | Wakes the machine |
| --- | --- | --- |
| `M3CodeUsageLimitWatchdog` | Every 5 minutes | No |
| `M3CodeUsageLimitWatchdogWake` | Once, at the next known reset (+3 min) | Yes |

Every scan re-arms the single-shot task for the earliest reset it is currently
waiting on, and deletes it when nothing is waiting. That is the difference
between a machine that gets up when there is something specific to do and one
that is woken every five minutes all night for nothing.

Both tasks run on battery and start late if the machine was off at the appointed
minute.

Neither points at a console program. A task that does opens a real window on
every run and steals focus, and nothing can suppress it after the fact - by the
time anything could hide the window, it has already appeared. `install`
therefore hands the task to `~/.claude/scripts/Check-ConsolePopupTasks.ps1
-Fix`, the machine's own wrapper tool, rather than writing a wrapper of its own:
one pattern on the machine means the audit can see every task, including this
one. If that helper is missing, `install` removes the task again rather than
leave a window-flashing one behind.

Each scan also re-runs that audit once a day and reports anything on the machine
that would flash, in `pnpm watchdog:status`.

**If you decide you hate the machine waking itself:**

```
pnpm watchdog:install -- --no-wake   # keep the watchdog, never wake the machine
pnpm watchdog:uninstall              # remove both tasks entirely
```

`--no-wake` is remembered in `~/.t3/watchdog/config.json`, so scans stop arming
the wake task from then on. With waking off, a reset that lands while the
machine sleeps simply waits until you wake it up.

## What it lists but never touches

The watchdog restarts one thing only: work stopped by a usage limit that has
lifted. A conversation that died on a crash is deliberately left alone - the
repository may be in a state nobody should resume blind.

Left alone, though, turned into invisible: nothing anywhere surfaces a
conversation that stopped mid-turn, and one was found with real work in it after
29 days. So `pnpm watchdog:status` ends with every conversation left mid-work and
quiet for more than two days, longest-forgotten first, with what stopped it. A
turn that is still marked `running` after weeks is the fingerprint of the app
being killed under it; those never produce an error at all, which is exactly why
they went unseen.

Nothing on that list is ever restarted. Seeing it is the point.

## When the app itself is down

The wake-up is delivered through the running app, so a crashed app leaves the
watchdog with nothing to do. It does not relaunch the app - that is a bigger
liberty than sending a message, and the decision is Martin's.

What it does instead is keep the bill. Every scan that finds the app down is
recorded as part of a stretch, along with how many conversations were sitting
there with a lifted limit at the time, and `pnpm watchdog:status` reports the
total. So the question "should it be allowed to relaunch the app" gets answered
against what it has actually cost rather than a hypothetical.

## Artefacts

Everything lands under `~/.t3/watchdog`:

| File | What it holds |
| --- | --- |
| `scans/<id>.json` | The full snapshot, every per-conversation verdict, and the wake decision for one cycle |
| `latest-scan.json` | The most recent cycle's summary |
| `receipts/<threadId>.json` | Per-conversation history: what was seen, decided, and poked |
| `ledger.json` | Every nudge ever sent; also what enforces the caps |
| `watchdog.log` | One line per cycle |
| `scan-runs.log` | Raw output of the scheduled runs |
| `config.json`, `wake-task.json` | Whether waking is allowed, and what the wake is currently armed for |
| `app-outages.json` | Every stretch where the app was down and the watchdog could do nothing |

Each scan record also carries the abandoned list as it stood at that moment.

## Rehearsing it

`pnpm watchdog:rehearse` stages the whole failure on demand: it copies the live
schema and the conversations the watchdog would look at into a throwaway store,
plants a stalled supervisor and two stalled workers (two accounts), and runs the
real scan against the copy four times over. Nothing is ever sent - delivery is
simulated so the sequence can advance - and it checks its own expectations, so
it exits non-zero if the ordering, the one-at-a-time hold, or the per-account
parallelism ever regress. Add `--keep` to leave the sandbox behind and read the
receipts it wrote.

Worth re-running after any change to the decision rules; it is the only thing
that exercises the ordering claim without waiting for a real usage limit.

## Commands

```
pnpm watchdog                 # one cycle by hand
pnpm watchdog -- --dry-run    # decide and record, but send nothing
pnpm watchdog:status          # last cycle and recent nudges
pnpm watchdog:rehearse        # self-checking dress rehearsal
pnpm watchdog:install         # register both scheduled tasks
pnpm watchdog:uninstall       # remove them
```

Minting a token requires `apps/server/dist/bin.mjs`, so the server has to have
been built at least once.
