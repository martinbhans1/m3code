# Default model

In **Settings → Chat**, enable **Use a default model** and choose the model,
provider account, and reasoning options under **Default model**. This preference
is saved on the connected server and applies to new threads. Turning it off keeps
your saved choice and makes new threads inherit the current chat's model, account,
and reasoning options. With no current chat, the usual last-used fallback applies.
Existing chats and unfinished drafts keep their selections.

Each connected environment has its own setting and provider accounts. Current-chat
inheritance applies within the same environment. The Orchestrator's own
meta conversation retains its Claude selection because its tools require Claude.

## Integrations

Send `"modelSelection": "default"` on an orchestration `thread.create` command
over HTTP or WebSocket. The server resolves it to the enabled setting, including
the account and model options, and stores that concrete selection on the thread.
Leave `modelSelection` out of subsequent `thread.turn.start` commands to keep using
the thread's selection. Explicit model selections continue to take precedence.

The Orchestrator's `create_thread` tool accepts `"model": "default"`. Omitting
`model` also uses the enabled default, falling back to the project's selection and
then the caller's model when the setting is off. Explicit model IDs still use the
Orchestrator's allowed model choices.

An explicit `default` request fails if no default is enabled and selected. Changing
the setting affects the next newly created thread, without changing ongoing work.
Integrations that currently send a hard-coded model must opt into `default` once;
future model changes can then be made in Settings alone.
