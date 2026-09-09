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
   stalled more than 12 hours ago - is recorded and left alone.
3. **Act** (`lib/watchdog-nudge.ts`) - opens an authenticated WebSocket to the
   running app and dispatches an ordinary `thread.turn.start`, the same command
   the composer sends. The bearer token is minted headlessly from the bundled
   `t3 auth session issue` CLI and cached until shortly before it expires.

Supervising conversations (those in the orchestrator project) are woken before
the conversations they supervise, so supervision restarts first.

## What stops it spending in a loop

- **One conversation per scan.** The next one waits until the woken one visibly
  moved. If the limit had not really lifted, that costs one nudge, not five.
- **Two attempts per conversation per reset window**, and never twice inside
  twenty minutes.
- **Rolling caps**: eight nudges per six hours, twenty per day, counted from the
  on-disk ledger, so a killed process does not reset the count.
- **Refusals**: if the app is not running, if more than twelve conversations look
  stalled at once, or if the reset time cannot be read out of the message, it
  does nothing and says why.

## Artefacts

Everything lands under `~/.t3/watchdog`:

| File | What it holds |
| --- | --- |
| `scans/<id>.json` | The full snapshot and every per-conversation verdict for one cycle |
| `latest-scan.json` | The most recent cycle's summary |
| `receipts/<threadId>.json` | Per-conversation history: what was seen, decided, and poked |
| `ledger.json` | Every nudge ever sent; also what enforces the caps |
| `watchdog.log` | One line per cycle |
| `scan-runs.log` | Raw stdout/stderr of the scheduled runs |

## Commands

```
pnpm watchdog                 # one cycle by hand
pnpm watchdog -- --dry-run    # decide and record, but send nothing
pnpm watchdog:status          # last cycle and recent nudges
pnpm watchdog:install         # register the scheduled task (every 5 minutes)
pnpm watchdog:uninstall       # remove it
```

The Windows scheduled task is named `M3CodeUsageLimitWatchdog` and runs
`~/.t3/watchdog/run-scan.cmd`, which is written by `install`. It runs while the
user is logged on; it does not need the app, a terminal, or a Claude session to
be alive, only the machine to be awake.

Minting a token requires `apps/server/dist/bin.mjs`, so the server has to have
been built at least once.
