---
summary: "Setting up ACP agents: acpx harness config, plugin setup, permissions"
read_when:
  - Installing or configuring the acpx harness for Claude Code / Codex / Gemini CLI
  - Enabling the plugin-tools or OpenClaw-tools MCP bridge
  - Configuring ACP permission modes
title: "ACP agents — setup"
---

For the overview, operator runbook, and concepts, see [ACP agents](/tools/acp-agents).

This page covers acpx harness config, plugin setup for the MCP bridges, and permission configuration.

Use this page only when you are setting up the ACP/acpx route. For native Codex
app-server runtime config, use [Codex harness](/plugins/codex-harness). For
OpenAI API keys or Codex OAuth model-provider config, use
[OpenAI](/providers/openai).

Codex has two OpenClaw routes:

| Route                      | Config/command                                         | Setup page                              |
| -------------------------- | ------------------------------------------------------ | --------------------------------------- |
| Native Codex app-server    | `/codex ...`, `openai/gpt-*` agent refs                | [Codex harness](/plugins/codex-harness) |
| Explicit Codex ACP adapter | `/acp spawn codex`, `runtime: "acp", agentId: "codex"` | This page                               |

Prefer the native route unless you explicitly need ACP/acpx behavior.

## acpx harness support (current)

Built-in acpx harness aliases (from the pinned `acpx` dependency):

| Alias        | Wraps                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| `claude`     | [Claude Code](https://claude.ai/code)                                                                  |
| `codex`      | [Codex CLI](https://developers.openai.com/codex/cli)                                                   |
| `copilot`    | [GitHub Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli) |
| `cursor`     | [Cursor CLI](https://cursor.com/docs/cli/acp) (`cursor-agent acp`)                                     |
| `droid`      | [Factory Droid](https://www.factory.ai)                                                                |
| `fast-agent` | [fast-agent](https://fast-agent.ai)                                                                    |
| `gemini`     | [Gemini CLI](https://github.com/google-gemini/gemini-cli)                                              |
| `grok-build` | [Grok Build](https://docs.x.ai/build/overview) (`grok agent stdio`)                                    |
| `iflow`      | [iFlow CLI](https://github.com/iflow-ai/iflow-cli)                                                     |
| `kilocode`   | [Kilocode](https://kilocode.ai)                                                                        |
| `kimi`       | [Kimi CLI](https://github.com/MoonshotAI/kimi-cli)                                                     |
| `kiro`       | [Kiro CLI](https://kiro.dev)                                                                           |
| `mcode`      | MiniMax Code (`mcode acp`; install and authenticate its CLI on the Gateway host)                       |
| `mux`        | [Mux](https://mux.coder.com)                                                                           |
| `opencode`   | [OpenCode](https://opencode.ai)                                                                        |
| `openclaw`   | OpenClaw ACP bridge (native `openclaw acp`)                                                            |
| `pi`         | [Pi Coding Agent](https://github.com/earendil-works/pi)                                                |
| `pool`       | Pool (`pool acp`)                                                                                      |
| `qoder`      | [Qoder CLI](https://docs.qoder.com/cli/acp)                                                            |
| `qwen`       | [Qwen Code](https://github.com/QwenLM/qwen-code)                                                       |
| `trae`       | [Trae CLI](https://docs.trae.cn/cli)                                                                   |
| `zeroclaw`   | ZeroClaw (`zeroclaw acp`)                                                                              |

`factory-droid` and `factorydroid` also resolve to the built-in `droid` adapter.

When OpenClaw uses the acpx backend, prefer these values for `agentId` unless your acpx config defines custom agent aliases.
`grok-build` is an ACPX agent target, not the xAI model id `xai/grok-build-0.1`. Use `agentId: "grok-build"` to launch the Grok Build CLI through ACP; use `xai/grok-build-0.1` only when selecting that model on OpenClaw's xAI provider route.
If your local Cursor install still exposes ACP as `agent acp`, override the `cursor` agent command in your acpx config instead of changing the built-in default.

Direct acpx CLI usage can also target arbitrary adapters via `--agent <command>`, but that raw escape hatch is an acpx CLI feature (not the normal OpenClaw `agentId` path).

Model control is adapter-capability dependent. Codex ACP model refs are
normalized by OpenClaw before startup. Other harnesses need an advertised model
config option with `session/set_config_option`, or legacy ACP `models` with
`session/set_model`. Without supported ACP model control or an adapter-specific
startup model flag, OpenClaw/acpx cannot force a model selection.

## GitHub Copilot CLI in native chat

GitHub Copilot CLI can serve ordinary OpenClaw chat through the installed-agent
model picker, including web chat and channels. This route uses the local
`copilot --acp --stdio` process, not an OpenClaw API-provider credential.

Install an ACP-capable CLI and sign in under the same OS account that runs the
Gateway. Copilot CLI 1.0.86 supports model discovery and selection over ACP:

```bash
npm install -g @github/copilot
copilot --version
copilot login
```

Refresh the model catalog, then choose an `acp-copilot/<model-id>` entry. OpenClaw
uses only the models advertised by that CLI; it does not supply a static model
list. Installation detection alone does not prove authentication or model access.
To prevent new native Copilot turns and catalog discovery, set
`plugins.entries.acpx.config.nativeAgents.copilot` to `false`. Classic
`/acp spawn copilot` sessions and `acp.allowedAgents` are separate.

Copilot owns authentication and billing:

- Native GitHub authentication uses the CLI's OAuth login or its supported GitHub
  token routes, including an authenticated `gh` fallback. Environment tokens
  (`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`) can override a stored login.
- Copilot model usage consumes the account's plan allowance. Do not assume a
  model is free because its catalog entry is available; check the account's
  included usage and additional-usage budget.
- Explicit CLI BYOK configuration (`COPILOT_PROVIDER_*`,
  `COPILOT_PROVIDERS_CONFIG`, or the CLI's `providers.json`) can route model
  requests to a separately billed provider even when GitHub login is available.
  Configure that route deliberately. OpenClaw does not choose it or copy an
  OpenClaw API credential into the native harness.

See GitHub's [CLI authentication guide](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli)
and [Copilot billing guide](https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing)
for account and plan requirements. Native chat permission and sandbox boundaries
below still apply.

Installed native agents keep their own sign-in. During discovery, `/models` can
report **Checking native agent** without requiring an OpenClaw API key. If
availability is unconfirmed, check the native app on the Gateway host and run
`/models` again.

<a id="tool-profiles-for-native-chat-runtimes" />

## Permissions for native chat runtimes

Enable an installed agent from **Models → Installed agents**. For a runtime that
uses its own native permissions, OpenClaw asks **Use {runtime}’s native permissions?**
before enabling it. Accepting remembers consent for the selected OpenClaw agent
in the same config update as enablement. New chats using that runtime then start
with **Full access** and optional sandboxing off, without repeating the prompt.
Enabling a native app does not sign you in to that app.

The native agent uses its own permissions on the Gateway host. OpenClaw does not
claim to enforce its optional tool restrictions inside that agent. Other agents
and their chats stay unchanged, and tools hosted by OpenClaw retain their policy.
Remove the runtime ID from `agents.entries.<agentId>.nativeRuntimeConsent` to
revoke remembered consent. Disabling and re-enabling the app does not erase it.

For a runtime configured manually without remembered consent, the Control UI
still offers **Continue for this chat** to an administrator when selecting the
runtime or sending a message with that selection. This fallback changes only
that chat's permissions.

Declining leaves permissions unchanged and keeps the message unsent. A first send
can create an empty chat so confirmation is bound to that chat, but no message is
saved or run before you confirm. Confirmation saves the permissions and retries
that message once, including a chat's first message, without pinning its default model.
Selection-only confirmation does not send the draft. This per-chat consent is
not inherited by another chat and is cleared when the session resets or the
selected runtime changes.

Required sandboxes, required workspace boundaries, and incompatible remote
execution placement cannot be waived by this confirmation. A restricted user
must ask an administrator or choose a compatible runtime.

## Required config

Core ACP baseline:

```json5
{
  acp: {
    enabled: true,
    // Optional. Default is true; set false to pause ACP dispatch while keeping /acp controls.
    dispatch: { enabled: true },
    backend: "acpx",
    defaultAgent: "codex",
    allowedAgents: [
      "claude",
      "codex",
      "copilot",
      "cursor",
      "droid",
      "gemini",
      "grok-build",
      "iflow",
      "kilocode",
      "kimi",
      "kiro",
      "openclaw",
      "opencode",
      "pool",
      "qwen",
    ],
    stream: {
      deliveryMode: "live",
    },
  },
}
```

Thread binding config is shared across supported channel adapters:

```json5
{
  session: {
    threadBindings: {
      enabled: true,
      idleHours: 24,
      maxAgeHours: 0,
      spawnSessions: true,
    },
  },
}
```

If thread-bound ACP spawn does not work, verify the adapter feature flag first:

- Discord: `session.threadBindings.spawnSessions=true`

Current-conversation binds do not require child-thread creation. They require an active conversation context and a channel adapter that exposes ACP conversation bindings.

See [Configuration Reference](/gateway/configuration-reference).

## Repair existing bare-session histories

ACPX isolates bare session names by OpenClaw owner. If a session reports
`SESSION_OWNER_MIGRATION_REQUIRED`, stop the Gateway and run
`openclaw doctor --fix`, then restart. Doctor uses the same service workspace
as the Gateway; ACPX's default state directory is `<service workspace>/state`.

The repair requires one current, unambiguous stored owner claim with matching
backend identifiers. It preserves the raw history, event-log references, upstream
session IDs, timestamps, options, and usage. Persistent record names move to an
owner-qualified resource; existing oneshot physical IDs and histories remain intact.
Ambiguous, stale, conflicting, unreadable, or live records remain in place with a
diagnostic. Resolve the reported evidence problem before retrying; resetting the
session does not bypass this repair.

This is an offline, crash-recoverable migration with atomic destination-file
publication. Files and SQLite are not one atomic transaction. Interrupted repairs
can be rerun: Doctor checks the existing destination and stored owner claim before
finishing the metadata update and archiving the old persistent record.

## Plugin setup for acpx backend

Packaged installs use the official `@openclaw/acpx` runtime plugin for ACP.
Install and enable it before using ACP harness sessions:

```bash
openclaw plugins install @openclaw/acpx
openclaw config set plugins.entries.acpx.enabled true
```

Source checkouts can also use the local workspace plugin after `pnpm install`.

Start with:

```text
/acp doctor
```

If you disabled `acpx`, denied it via `plugins.allow` / `plugins.deny`, or want
to switch back to the packaged plugin, use the explicit package path:

```bash
openclaw plugins install @openclaw/acpx
openclaw config set plugins.entries.acpx.enabled true
```

Local workspace install during development:

```bash
openclaw plugins install ./path/to/local/acpx-plugin
```

Then verify backend health:

```text
/acp doctor
```

<a id="acpx-runtime-startup-probe" />

### acpx runtime startup check

The `acpx` plugin embeds the ACP runtime directly (no separate `acpx` binary or
version to configure). By default it registers the embedded backend during
Gateway startup and waits for one health check before the gateway `ready`
signal. That check also supplies failure diagnostics and is bounded by
`plugins.entries.acpx.config.timeoutSeconds`; an unhealthy result does not
launch a second check. Set `OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE=0` or
`OPENCLAW_SKIP_ACPX_RUNTIME_PROBE=1` only for scripts or environments that
intentionally keep the startup check disabled.

Health checks run from the plugin-owned `<state>/acpx` directory, which the
service creates before probing. They do not require the default agent workspace
to exist. Sessions still launch in their requested `cwd`, falling back to the
configured plugin or service workspace when no session directory is supplied.

A failed check makes the backend unavailable for ACP spawns across the Gateway.
After correcting the cause, run `/acp doctor` to check again; a successful check
restores availability without restarting. Spawn attempts do not automatically
retry the health check.

Override an individual ACP agent command with structured arguments when a path
or flag value should remain one argv token:

```json
{
  "plugins": {
    "entries": {
      "acpx": {
        "enabled": true,
        "config": {
          "agents": {
            "claude": {
              "command": "node",
              "args": ["/path/to/custom adapter.mjs", "--verbose"]
            }
          }
        }
      }
    }
  }
}
```

- `agents.<id>.command` is the executable or existing command string for that ACP agent. An existing absolute executable path stays one argument even when it contains spaces.
- `agents.<id>.args` is optional. Each item is passed unchanged, including empty strings, spaces, quotes, and backslashes. Do not add shell quoting inside the array.

On Windows, put the executable path in `command` and its flags in `args`.
Quote relative executable paths containing spaces when using a command string.
Generated adapter wrappers also use argv arrays. Reconnecting an unchanged
session preserves its saved command representation and conversation history.

See [Plugins](/tools/plugin).

### Agent account usage

An ACP agent with its own login (and its own credits) can show its account
balance next to model providers: on the Usage page (provider plans and billing),
in **Plan limits** on the Models page, and in `/usage`-style status text. Add a
`usage` object to the agent's entry:

```json
{
  "plugins": {
    "entries": {
      "acpx": {
        "config": {
          "agents": {
            "junie": {
              "command": "/path/to/junie",
              "args": ["--acp=true"],
              "usage": { "command": "stats" }
            }
          }
        }
      }
    }
  }
}
```

- `usage.command` is one of the agent's own slash commands that prints its
  account usage, without the slash. Unset, the first advertised one of `usage`
  and `stats` is used. The command is only sent when the agent advertises it in
  its command list, so an agent without it never gets a model prompt.
- `usage.timeoutMs` bounds one probe (default 30000, 1000–300000).
- `usage.cacheTtlMs` is how long a balance is reused (default 600000, at least
  10000). A failed probe is retried after a minute; the last good balance stays
  visible meanwhile, with its age.
- `usage.label` names the entry (default: the agent's `agentIdentities` name,
  else its id with a capital letter).

The probe starts the agent in a temporary directory, opens a session of its own,
sends the command, closes that session and stops the process. It never touches
the agent's other sessions. It runs in the background: the page shows the cached
balance with its age ("Checked 5 minutes ago") or "Checking…" on the first read
and fills in when the probe finishes. The agent process inherits the same
environment as ACP sessions (`agentProcessEnvAllow` / `agentProcessEnvBlock`).

The reply is read as `key: value` lines, so any agent that prints them works:

- `Balance left`, `Balance`, `Remaining balance`, `Credit balance`, `Credits left`
  or `Remaining credits` with `<number> <unit>` becomes the balance
  (`1,234.50 USD`, `36.01 credits`; no unit means credits).
- `License`, `Plan`, `Subscription` or `Tier` becomes the plan.
- An account on its own API keys usually prints no balance; the entry then shows
  only the plan.
- A reply that says the agent is not logged in, an empty reply, a single error
  line, a missing command or a timeout becomes an error on that entry only.

Each agent appears as its own entry (`acp-<id>`, for example `acp-junie`). It is
not a model provider and adds no models. Plugins can contribute such entries for
other runtimes with `api.registerUsageSource`.

### Automatic adapter download

`acpx` auto-downloads ACP adapters (for example the Claude and Codex ACP
bridges) via `npx` on first use. You do not need to install adapter packages
manually, and there is no separate postinstall step for OpenClaw itself. If an
adapter download or spawn fails, `/acp doctor` reports the failure.

### Plugin tools MCP bridge

By default, ACPX sessions do **not** expose OpenClaw plugin-registered tools to
the ACP harness.

If you want ACP agents such as Codex or Claude Code to call installed
OpenClaw plugin tools such as memory recall/store, enable the dedicated bridge:

```bash
openclaw config set plugins.entries.acpx.config.pluginToolsMcpBridge true
```

What this does:

- Injects a built-in MCP server named `openclaw-plugin-tools` into ACPX session
  bootstrap.
- Exposes plugin tools already registered by installed and enabled OpenClaw
  plugins.
- Passes the active ACP session identity to plugin tool factories, so
  agent-scoped tools stay in that agent's namespace.
- Keeps the feature explicit and default-off.

Security and trust notes:

- This expands the ACP harness tool surface.
- ACP agents get access only to plugin tools already active in the gateway.
- Treat this as the same trust boundary as letting those plugins execute in
  OpenClaw itself.
- Review installed plugins before enabling it.

Custom `mcpServers` still work as before. The built-in plugin-tools bridge is an
additional opt-in convenience, not a replacement for generic MCP server config.

### OpenClaw tools MCP bridge

By default, ACPX sessions also do **not** expose built-in OpenClaw tools through
MCP. Enable the separate core-tools bridge when an ACP agent needs selected
built-in tools such as `cron`:

```bash
openclaw config set plugins.entries.acpx.config.openClawToolsMcpBridge true
```

What this does:

- Injects a built-in MCP server named `openclaw-tools` into ACPX session
  bootstrap.
- Exposes selected built-in OpenClaw tools. The initial server exposes `cron`.
- Keeps core-tool exposure explicit and default-off.

### Runtime operation timeout configuration

The `acpx` plugin gives embedded runtime startup and control operations 120
seconds by default. This gives slower harnesses such as Gemini CLI enough time
to complete ACP startup and initialization. Override it if your host needs a
different operation limit:

```bash
openclaw config set plugins.entries.acpx.config.timeoutSeconds 180
```

Runtime turns use OpenClaw agent/run timeouts, including `/acp timeout`.
An interactive turn can continue beyond the plugin operation limit until its
turn budget expires, the harness finishes, or you cancel it.
`sessions_spawn` does not accept per-call timeout overrides; the operator path
is `agents.defaults.subagents.runTimeoutSeconds`. With the default hybrid reload
mode, changing `timeoutSeconds` automatically reloads the plugin. See
[Config hot reload](/gateway/configuration/hot-reload).

<a id="health-probe-agent-configuration" />

### Health check agent configuration

When `/acp doctor` or the startup check verifies the backend, the bundled `acpx`
plugin checks one harness agent. If `acp.allowedAgents` is set, it defaults to
the first allowed agent; otherwise it defaults to `codex`. If your deployment
needs a different ACP agent for health checks, set the check agent explicitly:

```bash
openclaw config set plugins.entries.acpx.config.probeAgent claude
```

With the default hybrid reload mode, this change automatically reloads the plugin.
Run `/acp doctor` to check the updated backend.

<a id="agent-process-environment" />

### Agent process environment

By default, ACP agents, their command probes, and the terminals they open
inherit the whole Gateway environment, including the Gateway's own credentials.
Two optional plugin settings narrow what they inherit. Both are unset by
default, which keeps that behavior unchanged.

- `agentProcessEnvAllow`: when set, children inherit only process essentials
  (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LANGUAGE`, `TZ`,
  `TMPDIR`, `TMP`, `TEMP`, every `LC_*` and `XDG_*`, plus the Windows system
  and profile variables on Windows) and the listed names. An empty list keeps
  essentials only.
- `agentProcessEnvBlock`: names children do not inherit.

They apply in this order: the allowlist first, then the blocklist removes names
from the result, then explicit grants apply last and always win. Explicit grants
are `ACPX_AUTH_*` variables, credentials the runtime injects for an agent, and
variables OpenClaw sets itself (such as the default `TOKIO_WORKER_THREADS`
cap). Names are case-sensitive except on Windows, and must not contain `=` or
whitespace.

Example that keeps OpenClaw's own credentials away from ACP agents while they
still inherit everything else:

```json
{
  "plugins": {
    "entries": {
      "acpx": {
        "config": {
          "agentProcessEnvBlock": [
            "OPENCLAW_GATEWAY_TOKEN",
            "OPENCLAW_HOOK_TOKEN",
            "OP_CONNECT_TOKEN",
            "ANTHROPIC_API_KEY",
            "OPENAI_API_KEY"
          ]
        }
      }
    }
  }
}
```

Block a provider key only when the ACP agent does not need it: an agent that
authenticates with that key can no longer start. MCP servers the agent launches,
including the OpenClaw tool bridges, normally inherit the agent's environment
too. With an allowlist, also list what they need, such as `OPENCLAW_STATE_DIR`
or `OPENCLAW_CONFIG_PATH` when the Gateway uses them, and any variable your
config references. New settings apply to agents started after the plugin
reloads.

## Permission configuration

ACP sessions run without an interactive TTY for file-write and shell-exec
permission prompts. This does not disable ACP form or URL elicitation during a
channel-delivered turn: those requests use transient Gateway questions instead.
With `nonInteractivePermissions: ask` (the default in this fork), permission
prompts use the same Gateway questions, so they appear in the chat as buttons.
The acpx plugin provides two config keys that control harness permissions,
`permissionMode` and `nonInteractivePermissions`, both described below.

These ACPX harness permissions are separate from OpenClaw exec approvals and separate from CLI-backend vendor bypass flags such as Claude CLI `--permission-mode bypassPermissions`. ACPX `approve-all` is the harness-level break-glass switch for ACP sessions.

For the broader comparison between OpenClaw `tools.exec.mode`, Codex Guardian
approvals, and ACPX harness permissions, see
[Permission modes](/tools/permission-modes).

### `permissionMode`

Controls which operations the harness agent can perform without prompting.

| Value           | Behavior                                                  |
| --------------- | --------------------------------------------------------- |
| `approve-all`   | Auto-approve all file writes and shell commands.          |
| `approve-reads` | Auto-approve reads only; writes and exec require prompts. |
| `deny-all`      | Deny all permission prompts.                              |

### `nonInteractivePermissions`

Controls what happens when a permission prompt would be shown but no interactive TTY is available (which is always the case for ACP sessions).

| Value  | Behavior                                                                                    |
| ------ | ------------------------------------------------------------------------------------------- |
| `ask`  | Ask in the turn's chat with buttons; deny when there is no chat or no answer. **(default)** |
| `fail` | Abort the session with `PermissionPromptUnavailableError` (upstream default).               |
| `deny` | Silently deny the permission and continue (graceful degradation).                           |

### Permission questions in chat (`ask`)

When an ACP agent (any agent: Junie, Codex, Claude Code, Gemini, ...) sends
`session/request_permission` for an action that `permissionMode` does not settle
(with `approve-reads`: writes, edits, deletes, moves, shell commands, fetches),
OpenClaw asks the user in the chat the turn came from, the same way it asks ACP
form questions.

**Where the buttons appear.** The question belongs to the conversation the
message was typed in:

- A chat bound to an ACP session (`/acp spawn <agent> --bind here`, an agent
  picked in the model picker, an imported chat continued with an agent): the
  buttons appear in that chat, and its sidebar row shows "Waiting for your
  answer". Before this, the question was filed under the ACP session's own key
  and the bound chat showed only "working".
- A message sent to the ACP session itself: the buttons appear there.
- A bound channel conversation or thread (Telegram, Discord, Slack, ...): the
  question is sent there with native buttons where the channel has them, like
  any agent question; a typed reply (number or option text) answers it too.

ACP form questions (`session/elicitation`) follow the same rule.

**What an agent can ask, and how it is shown.**

| Request                                                     | Arrives as                                                                                                                                                                                                      | Shown as                                                                                                              | Default                                                        |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Permission for a tool call                                  | `session/request_permission`, tool kind `read`, `search`, `edit`, `delete`, `move`, `execute`, `fetch`, `think`, `switch_mode` or `other`; options `allow_once`, `allow_always`, `reject_once`, `reject_always` | Question: **Allow once**, **Allow always**, **Deny**, **Deny always**                                                 | `approve-reads`: kind `read`/`search` approved, the rest asked |
| A decision of the agent's own (a plan review, a step limit) | `session/request_permission` whose option names are not allow/deny wording (Implement / Spawn agentic team / Revise / Save the plan and stop; Stop / Continue)                                                  | Question titled "Decision" with the agent's option names; long text (the plan) posted in full as a chat message first | Always asked; no read rule answers it                          |
| A form or a choice                                          | `session/elicitation` (form: string, number, boolean, single and multi select; or URL)                                                                                                                          | The same question card: fields, choices, free text                                                                    | Always asked (15 minutes, then cancelled)                      |
| A free question                                             | The agent's reply text, ending its turn                                                                                                                                                                         | A normal reply; the user answers by writing                                                                           | Not a question record                                          |

JetBrains Junie uses all four: file access outside its project and edits as
`other` ("Allow viewing files?", "Allow changes in this file?"), terminal
commands as `execute`, its plan review and step limit as decisions, its
`AskUser` questions as forms when the client supports forms (OpenClaw does),
and plain questions as reply text. Junie does not ask for reads inside its
project.

**What the question says.** It names the agent, the action (the tool title, its
kind unless it is the uninformative `other`), the files it touches (ACP tool
call `locations`) and its input, and shows one button per option the agent
offers:

| ACP option kind | Button       |
| --------------- | ------------ |
| `allow_once`    | Allow once   |
| `allow_always`  | Allow always |
| `reject_once`   | Deny         |
| `reject_always` | Deny always  |

The agent's own wording of an option goes to the button's description, so the
scope of an "always" answer is visible: Junie's `Always allow ("/repo/*")`
becomes **Allow always** with the description `/repo/*`. When an agent offers
one kind twice (two "always" scopes), the scope goes into the label so the
buttons differ: **Allow always** and **Allow always: /repo/src/\***.

The user can also reply with the option number or text. The answer goes back to
the agent and the turn continues.

- **Long input** (a plan in markdown, a file body) longer than 600 characters
  is posted in full as a chat message just before the question, and the
  question points to it; tool input is shown field by field, not as escaped
  JSON.
- **Several requests at once** (an agent running tool calls in parallel, a
  form while a permission question is open) are asked one after another in
  the same chat; each is answered on its own and none is denied for being
  second.
- **Allow always** is passed to the agent as its `allow_always` option; the
  agent keeps its own scope for it (Junie writes the pattern to
  `~/.junie/allowlist.json` and stops asking for it). OpenClaw also remembers
  it for the session, but only for the identical request (same tool kind,
  title, files and input), so an agent that asks the same thing again is
  answered without a question. A generic title such as "Allow viewing files?"
  for another file is asked again. The memory ends when the Gateway restarts.
- **No answer** within 30 minutes (the exec approval timeout,
  `DEFAULT_EXEC_APPROVAL_TIMEOUT_MS`) denies the action; the agent gets the
  rejection and the turn continues. The chat says so and what to do.
- **No chat to ask in**: turns that run through the Gateway `agent` method
  (cron, `openclaw agent`, the task turn of `sessions_spawn`) and turns whose
  replies are suppressed. The action is denied at once, the run's status events
  and the Gateway log say why, and the turn continues instead of failing. Talk
  to the agent in a bound chat or thread (`/acp spawn`, `/focus`) to approve
  actions there.
- **Stop, cancel, close, restart**: a user Stop, a turn cancel or an ACP session
  close aborts the request (acpx aborts its signal); the question is withdrawn,
  its buttons disappear and the action is denied. Questions live in Gateway
  memory, so after a Gateway restart the Control UI drops the stale card on
  reconnect and the agent process is gone with its request.
- While the question waits, the turn keeps its watchdog hold, so the reply
  watchdog does not stop it for silence.

Reads are still auto-approved by `approve-reads`, `approve-all` still approves
everything without asking, and `deny-all` still denies without asking.

`approve-reads` recognizes a read by the ACP tool kind (`read`, `search`) or a
title that starts with `read`, `cat`, `search`, `find` or `grep` (acpx's
classification). A request that an agent sends with kind `other` and a title
such as "Allow viewing files?" is not a read to it and is asked. JetBrains Junie
sends exactly that, and only for files **outside its project directory** (the
ACP session's working directory, its `readOutsideProject` rule); it does not
ask for files inside it. If Junie asks for every file, the session's working
directory is not the project it works in. Fix that first: start the session in
the project (`/acp spawn junie --bind here --cwd /path/to/project`; without
`--cwd` the session inherits the OpenClaw agent's workspace), or press **Allow always** once to add the shown pattern to Junie's
allowlist, or add a `readOutsideProject` rule to `~/.junie/allowlist.json`.
OpenClaw does not guess that a request of kind `other` is a read.

With `ask` and `approve-reads`, the permission request is the approval point:
a file write (`fs/write_text_file`) or terminal command (`terminal/create`) that
the agent hands back to OpenClaw after the request is not gated a second time
(acpx would otherwise deny it for lack of a TTY and fail the turn). Such
operations stay inside the session working directory. This matches how native
harness sessions treat delegated operations.

### Configuration

Set via plugin config:

```bash
openclaw config set plugins.entries.acpx.config.permissionMode approve-all
openclaw config set plugins.entries.acpx.config.nonInteractivePermissions fail
```

With the default hybrid reload mode, these changes automatically reload the plugin.
See [Config hot reload](/gateway/configuration/hot-reload) for other reload modes.

<Warning>
Upstream OpenClaw defaults to `permissionMode=approve-reads` and `nonInteractivePermissions=fail`. With `fail`, any write or exec that triggers a permission prompt in an ACP session fails with `PermissionPromptUnavailableError: Permission prompt unavailable in non-interactive mode`.

This fork defaults to `nonInteractivePermissions=ask`, which asks in chat and denies (never fails) when it cannot ask. Set `deny` to deny restricted actions without asking, or `fail` for the upstream behavior.
</Warning>

## Related

- [ACP agents](/tools/acp-agents) — overview, operator runbook, concepts
- [Sub-agents](/tools/subagents)
- [Multi-agent routing](/concepts/multi-agent)
- [ACPx plugin reference](/plugins/reference/acpx) — the acpx runtime plugin's manifest and config, including the Pi session catalog
