# CI quality gates

- `.github/workflows/ci.yml` runs `bun run lint`, `bun run typecheck`, and `bun run test` on pull requests and pushes to `main`.
- `.github/workflows/release.yml` builds macOS (`arm64` and `x64`), Linux (`x64`), and Windows (`x64`) desktop artifacts from a single `v*.*.*` tag and publishes one GitHub release.
- The release workflow auto-enables signing only when secrets are present: Apple credentials for macOS and Azure Trusted Signing credentials for Windows. Without secrets, it still releases unsigned artifacts.
- See [Release Checklist](./release.md) for the full release/signing setup checklist.

## Console windows on Windows

`t3code/require-windows-hide` fails the lint run when a child process is started
without passing `windowsHide`. The flag is not inherited, so one missed call
site opens a console window over whatever the user is doing, every time it runs,
until somebody notices. Passing `windowsHide: false` is allowed - an installer
UI has to be visible - the rule only insists the choice is made.

The scheduled-task half of the same trap lives outside the repo: a task pointed
straight at a console program always flashes a window, and no setting suppresses
it. `~/.claude/scripts/Check-ConsolePopupTasks.ps1` audits for that shape and
`-Fix` wraps the offenders; the usage-limit watchdog runs that audit once a day
and reports offenders in `pnpm watchdog:status`.
