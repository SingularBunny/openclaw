---
summary: "Claude subscription limits (5-hour, weekly, per-model) always visible in the Control UI sidebar"
read_when:
  - You run models through the Claude CLI backend and want to see subscription limits
  - The Claude usage block is missing or out of date
title: "Claude usage indicator"
sidebarTitle: "Claude usage"
---

The Control UI shows your Claude subscription limits at the bottom of the expanded
sidebar, under the session list: one bar per window with the percentage used and
the time left until it resets. Hover a bar for the reset time as a relative and a
local date and time. The header shows the plan (for example `Max (20x)`) when the
login carries it.

| Bar        | Window                                                        |
| ---------- | ------------------------------------------------------------- |
| **5h**     | The rolling 5-hour session limit                              |
| **Week**   | The weekly limit across all models                            |
| Model name | The weekly per-model limit (Sonnet or Opus), and model limits |
| **Extra**  | Extra usage, when enabled and reported as a percentage        |

Bars turn amber from 70 % and red from 90 %. The block is hidden while the Gateway
has no Claude subscription data (no Claude login, an API-key-only setup, or the
first read is still running).

## Where the numbers come from

The Gateway method `usage.status` reports Claude subscription usage from Anthropic's
usage endpoint, the same figures as `claude.ai/settings/usage`. Credentials:

- An Anthropic OAuth or setup-token auth profile, as upstream.
- **Claude CLI login** (fork): when the config routes models through the
  `claude-cli` backend (a `claude-cli/...` model ref or `agentRuntime.id: "claude-cli"`),
  the Anthropic provider reads Claude CLI's own login file read-only
  (`~/.claude/.credentials.json`, or `CLAUDE_CONFIG_DIR`; never the macOS keychain).
  The access token is used only while it is valid and is never refreshed by
  OpenClaw: Claude CLI owns its refresh token, and refreshing it elsewhere would sign
  Claude CLI out. An expired token is picked up again after Claude CLI's next run
  refreshes it. The token never appears in responses or logs.

Refresh cadence:

- The Gateway caches usage for 60 seconds, so Anthropic is asked at most once a minute
  however many pages are open. After HTTP 429 it waits 2, 4, 8 … up to 15 minutes
  (or `Retry-After`) and keeps showing the last good figures.
- The sidebar re-reads `usage.status` every 30 seconds, when the tab becomes visible,
  and right after a chat turn ends.

## Limit reached

Claude CLI reports the subscription status on every turn (`rate_limit_event` in
`stream-json`). The Gateway keeps the latest one and adds it to `usage.status` as
`rateLimit` (`status`: `allowed`, `allowed_warning` or `rejected`; `limitType`;
`resetAt`), so a reached limit shows at once as "5h limit reached · resets in 1h 20m"
with that bar at 100 %, without waiting for the next usage read. The status clears
when its reset time passes.

## Status line

The status line under the chat composer repeats the 5-hour figure (`5h 42%`) for sessions on
Claude, from the same data; see [Chat](/web/control-ui/chat#status-line).
