# Orchestrator (meta conversations)

Use this when you have many conversations running at once and lose track of which
thread owns which piece of work.

The **Orchestrator** row in the sidebar opens a conversation that can see the
conversations you have shared with it, search across them, and post a message into one of them on
your behalf. That message starts a turn in the target thread, with that thread's
own worktree, branch, model and permissions already in place — so work goes back
to the conversation that already has the context, instead of starting over in a
fresh one.

Nothing here reads or writes your code. The orchestrator confers with you and
relays instructions; the thread it sends to does the actual work.

## Where it is

**Sidebar, above the pins.** The **Orchestrator** row is always there, whether or
not you have ever used it.

Clicking it opens the meta conversation, creating whatever is missing on the
way: on first click it makes a hidden `Orchestrator` project in the app's own
state directory, and a thread inside it. There is nothing to set up, and nothing
exists until you click.

The row is permanent; the conversation behind it is not. It reopens your most
recent meta conversation, and the **+** on the row starts a fresh one — the old
one stays in your history rather than growing forever. The project itself never
appears in the sidebar tree; it is plumbing, not somewhere you work.

The meta conversation always runs on Claude, regardless of your default
provider, because the cross-thread tools only exist there.

## Sharing conversations with it

Set this per conversation from the orchestrator control in its composer, next to
the model picker and the access/mode controls — or from the sidebar right-click
menu → **Orchestrator access**:

| Setting               | What the orchestrator can do                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| **Not shared**        | Nothing. The conversation is absent from listings and from search — not merely unsendable.               |
| **Watch**             | Read its state, messages, questions and follow-ups, and report on it. Sending and answering are refused. |
| **Watch and control** | Read it, and post messages into it.                                                                      |

The fourth choice, **Follow default**, is the one every conversation starts on:
it tracks **Settings → General → Orchestrator access** rather than pinning a
value, so changing that setting later moves the conversation with it.

That default ships as **Not shared**, so the orchestrator sees nothing until you
opt something in. Raising it to **Watch** or **Watch and control** flips the
model the other way — everything is shared unless you close it — and an explicit
**Not shared** on one conversation still holds it closed. Either way the
per-conversation control wins over the default, in both directions.

## Overriding all of it from the orchestrator

The orchestrator's own composer carries one more control — the same place the
other conversations carry theirs — and this one is not a per-thread setting or a
default. It overrides both, in either direction:

| Setting                       | What the orchestrator can reach                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| **Per conversation**          | Nothing changes: each conversation's own setting decides, falling back to the default. |
| **Shared, read-only**         | Everything you shared, readable but unsendable — whatever you set it to individually.  |
| **Read everything**           | Every conversation in every project, shared or not, readable. None can be sent to.     |
| **Read and steer everything** | Every conversation in every project, readable, sendable, and its follow-ups closable.  |

This exists because the per-conversation control is useless in the situation it
is most needed: you are away from your desk, you want the orchestrator to go
through everything you have running, and the one conversation you cared about
was never shared. Raising the default does not fix that either — a conversation
explicitly set to **Not shared** outranks the default. This outranks both, which
is why it lives in the orchestrator's own window rather than in Settings (though
it is mirrored at **Settings → General → What the orchestrator can reach**).

`list_threads` reports the current setting back to the orchestrator as
`accessMode`, so it can tell you "this is everything you have running" rather
than hedging about what might not be shared.

Revoking takes effect immediately: all three settings are re-read on every tool
call, not cached for the life of the session.

Its own earlier conversations are the one thing outside all of this. They are
always listed, searchable and readable, whatever the sharing settings say — they
are your meta conversations, sitting behind the same sidebar row, and without
them every new orchestrator conversation starts from nothing and re-decides what
the last one already settled with you. They are never sendable, at any setting:
two orchestrators steering each other is the one thing no override may enable.
The conversation you are in is left out of its own results.

## Tools

| Tool                     | What it does                                                                                                                                                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_threads`           | Your conversations with their agent state, branch, model and pending counts. Filter by project, or to only those needing attention. Returns a page at a time, with the true total alongside it.                                                                            |
| `search_threads`         | Find the thread that owns a topic, by keyword and by meaning, across titles and message content. Pass `exact` to grep for a literal string instead — an identifier, a file path, an error message.                                                                         |
| `read_thread`            | One conversation's recent messages, current state, open follow-ups, and the last few it has already closed — including which conversation picked up a spun-off one. Message text is truncated by default for orientation; raise `messageChars` to read a long one in full. |
| `list_pending`           | Everything waiting on you: approvals, questions, failures, turns you interrupted, and follow-up chips nobody has acted on. Each section is counted in full and returned a page at a time, and can be narrowed to a date range.                                             |
| `send_to_thread`         | Post a message into a conversation as you, starting a turn there.                                                                                                                                                                                                          |
| `create_thread`          | Open a new conversation in one of your projects and start it with an opening prompt.                                                                                                                                                                                       |
| `answer_thread_question` | Answer the question a conversation is stopped on, exactly as if you had clicked the option there.                                                                                                                                                                          |
| `respond_to_approval`    | Allow or refuse what a conversation is asking permission to do — run a command, read a file, write a change — exactly as if you had answered the dialog there.                                                                                                             |
| `stop_thread`            | Interrupt the turn a conversation is running. Nothing already done is undone; the turn just ends where it is.                                                                                                                                                              |
| `resolve_followup`       | Mark a follow-up to-do done, dismissed, or spun off into a named conversation, so it stops being reported as waiting on you and the link to whoever picked it up survives.                                                                                                 |
| `read_thread_changes`    | What changed on disk while a conversation ran: files with line counts per turn, and optionally the diff. Reports how far that is attributable to the conversation.                                                                                                         |

## Evidence, not testimony

`read_thread` tells you what an agent _said_ it did. `read_thread_changes` tells
you what actually landed on disk: every file touched with added/removed line
counts, broken down by turn, and — when you ask for it — the diff.

That difference matters more than it sounds. Agents routinely report work as
finished that was never written, or that does not compile. Without this the
orchestrator is a switchboard relaying claims; with it, it can check before
telling you something is done or closing a follow-up.

How much it proves depends on where the conversation works, and the tool now
says which case you are in. A conversation with its own worktree is essentially
alone there, so the numbers are its own. A conversation working in the project's
checkout is not: snapshots cover the whole checkout, so anything another
conversation — or you, in your editor — changed while it ran is counted too. In
that case treat the figures as an upper bound. If you want changes attributable
to one conversation, give it a worktree.

The file list is cheap and always included. The patch is not: it is opt-in via
`includePatch`, can be narrowed to a single turn with `turnCount`, and is
truncated well below what would bury the conversation. Turns whose checkpoint
failed to capture are left out entirely rather than reported with numbers
nobody can trust.

It needs only **Watch** — reading code is a read.

## Answering a conversation's questions

When a conversation stops to ask you something — the option list an agent puts
up mid-task — it does nothing at all until it gets an answer, and a message sent
with `send_to_thread` will not unblock it. The orchestrator can now clear that
without you opening the thread:

- `read_thread` and `list_pending` return the question, its options and each
  option's description, so the orchestrator can put the choice to you here.
- `answer_thread_question` sends your choice back, exactly as if you had clicked
  the option in that conversation. Its turn resumes on the spot.
- If none of the options is what you actually said, the orchestrator passes your
  own wording instead of rounding to the nearest option — the same thing as
  typing into the "type your own answer" box.

It needs **Watch and control**: on a **Watch** conversation the orchestrator can
read the question out to you but not answer it.

Same contract as sending — it shows you the question and the options, waits for
you to choose in that turn, and answers one request per approval. Put the meta
conversation in **approval-required** mode and each answer raises a real
approve/deny dialog first. Unlike a message, an answer cannot be taken back: the
other agent acts on it immediately.

## Answering a conversation's approvals

The same applies to a conversation stopped on an approval — permission to run a
command, read a file, or write a change — and this is usually the thing actually
blocking you while you are away from your desk.

- `read_thread` returns them as `pendingApprovals` and `list_pending` as
  `pendingApprovalRequests`, both carrying the detail of the request: the
  command line, the file path, the change. That detail is the point — an
  approval you have not read is not one you can give.
- `respond_to_approval` sends your decision back, exactly as if you had answered
  the dialog in that conversation. It takes effect immediately: the command
  runs, the file is written.
- **Allow for the session** is available but deliberately awkward: it stops that
  conversation asking again at all for the rest of its session, so the
  orchestrator only uses it when you say to stop being asked.

It needs **Watch and control**, like answering a question. On a **Watch**
conversation the orchestrator reads the request out to you and nothing more.

## Stalled conversations

A turn only stops being "running" because an event says so, and that event is
lost whenever the app is killed, a provider dies, or a machine sleeps. The
conversation then sits marked as working forever, with nothing behind it.

Anything still marked running but silent for over an hour is now reported as
**stalled** rather than working — in the sidebar, on the board, and to the
orchestrator as `phase: "stale"`. It is the difference between "five
conversations are working" and the truth, which is usually that none of them
are.

`stop_thread` clears one: it ends the turn so the conversation is usable again.
Nothing already done is undone — the files an agent wrote before it died stay
written — so the orchestrator checks `read_thread_changes` for what it actually
got done before and after. It asks first, because a conversation that really is
mid-task loses whatever it had not finished.

## The board

The orchestrator's conversation has a **Board** button next to its model picker.
It lists every conversation the orchestrator can currently see, grouped by what
each one needs:

- **Needs you** — waiting on an approval, asking a question, failed, interrupted
  and never resumed, or holding a plan to review
- **Stalled** — marked running, but silent long enough that the turn is almost
  certainly dead
- **Working** — genuinely running now
- **Settled** — finished, never run, or carrying open follow-ups

Interrupted-and-forgotten is deliberately filed under "needs you": nothing else
in the app nags about it, which is exactly why it gets lost.

Each row says when, phrased for what the group means — `waiting 12m`,
`running 3m`, `silent for 6d`, or when it finished. A question asked two minutes
ago and one asked on Tuesday need very different things from you, and that is
the whole reason to look at a board rather than a list.

Clicking a row opens that conversation. The **⋯** menu on it writes the sentence
you were about to type into the orchestrator's composer instead — "show me the
question this is asking", "clear the dead turn", "what did it actually change?"
— ready to edit or send. It proposes; nothing is sent until you send it.

## Starting new conversations

`create_thread` is for work no existing thread owns — a separate task, a clean
slate after a thread has gone long, or a second track to run alongside the
first. It takes a project, a title and the opening prompt, and it:

- **Asks first**, on the same contract as `send_to_thread`: it shows you the
  project, title and exact prompt, and one conversation per approval. In
  approval-required runtime mode that becomes a real approve/deny dialog.
- **Refuses to guess the project.** A name fragment that matches no project, or
  more than one, is an error naming the candidates rather than a coin flip.
- **Starts supervised.** A new conversation opens in **approval-required** mode
  unless the call asks for something looser — unlike a thread you start
  yourself, nobody is necessarily watching this one. Ask for full access
  explicitly if that is what you want.
- **Shares the project checkout by default, or takes its own.** Pass
  `envMode: 'worktree'` and the new conversation gets its own git worktree and a
  generated branch, so two tracks in one repository cannot edit the same files
  underneath each other. That is the mode to use when something is already
  running in that project. Worktree preparation can fail — no git, detached
  HEAD, a branch already checked out — and when it does the conversation is
  rolled back entirely and you get the git error rather than a half-built
  workspace. The project's setup script runs in the new worktree; if it fails,
  the conversation still opens and the result says so, since missing
  dependencies are recoverable but silently pretending they installed is not.
- **Can choose a model, but only from a list you curate.** Set that list in
  **Settings → General → Orchestrator model choices**; it can span providers.
  Claude Opus 5 and GPT-5.6 are sanctioned out of the box, both at medium
  effort. Clear the list to make new conversations inherit their project's
  default model instead.
- **Keeps what it opened.** The new conversation is shared back at **Watch and
  control** so the orchestrator can check on it, regardless of your default.

Prefer `send_to_thread` when a thread already holds the context — a new
conversation starts from nothing, so its opening prompt has to carry everything.

## Sending safely

`send_to_thread` and `create_thread` are the tools here that change anything,
and they are guarded the same ways:

- **It asks first.** The tool's contract requires the orchestrator to show you
  the exact message and target thread and get a yes in that turn.
- **Approval mode makes that enforced rather than conventional.** Put the meta
  conversation in **approval-required** runtime mode and every send raises a real
  approve/deny dialog before anything is posted.
- **Busy threads are protected.** Sending into a thread that is mid-turn fails
  unless the call explicitly opts into steering. Steering is not an abort: the
  provider appends the message to the turn already running and the agent picks
  it up at its next step, keeping the work it has done. It does redirect an
  agent mid-task, though, so it stays off by default. There is still no way to
  queue a message _until_ a turn finishes — the orchestrator has to wait and
  send, or steer.
- **Parked threads are refused outright.** A thread waiting on an approval or a
  question is waiting on you, and no message will unblock it. Answer it there.

It also refuses to send to its own thread, to another meta conversation (two
orchestrators could otherwise drive each other indefinitely), and to archived or
deleted threads.

A successful send means the turn was _accepted_, not that it ran. The target
thread starts on its own and can still fail to start — read it back if it
matters.

## Keeping it cheap

The orchestrator keeps its conversation with you like any other thread — what it
sent, to which thread, and why, all stay in context.

What it does not keep is a cached picture of your other conversations. Their
state changes by the minute, so it re-queries rather than trusting what it saw
earlier in the conversation. That is also why `read_thread` truncates message
bodies and `list_threads` returns summaries rather than transcripts: the point
is to stay cheap enough to re-ask every turn. Truncation is now a default rather
than a wall — `read_thread` takes a `messageChars` budget, so when a message it
cut turns out to be the one that matters, it can fetch the rest instead of
guessing at it.

The practical upshot is only that a long-running meta conversation is cheap to
replace — a new one can rebuild everything it needs from the tools in a couple
of calls. Start a fresh one when the old one has drifted onto a different
subject, not in the middle of something.

## How the gate works

Credentials are scoped per thread. When a turn starts,
`McpSessionRegistry.issue` looks up the thread's project and grants the
`orchestrator` capability only if it matches `orchestratorProjectId` in server
settings. The capability decides two things: whether the orchestrator MCP
endpoint is handed to the provider session at all, and whether the
`/mcp-orchestrator` route accepts the credential (it answers `403` otherwise).
Each tool re-checks the capability as well.

The credential is minted once per provider session and lives for hours, so the
capability alone would outlive the setting that justified it. Each tool call
therefore re-reads the setting and re-checks the calling thread's project before
doing anything.
