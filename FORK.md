# OpenClaw fork for ai-workbench

Branch `aiwb/2026.10.10`, based on the `v2026.10.10` release. Package builds and installation are
handled by [ai-workbench](https://github.com/SingularBunny/ai-workbench) (`tools/openclaw-fork-build.sh`,
`WORKBENCH_OPENCLAW_PACKAGE`). Without the settings below the fork behaves as upstream.

| Change                                                                                                                                          | Where                                                                          | Documentation                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Worker queue and heap limits from the environment (`OPENCLAW_WORKER_*`)                                                                         | `packages/worker-runtime`, state, transcript and SQLite workers                | [Environment variables](docs/help/environment.md#worker-and-catalog-limits) |
| Catalog continuation limits from the environment (`OPENCLAW_CATALOG_CONTINUATION_*`)                                                            | `src/plugins/session-catalog-history-import.ts`                                | [Session catalogs](docs/nodes/session-catalogs.md)                          |
| Owner imports (`OPENCLAW_CATALOG_IMPORT_OWNER=1`): `senderIsOwner`, no untrusted-reference notice or boundaries, earlier imports read unwrapped | catalog import, `packages/agent-core` session context, chat display projection | [Owner imports](docs/nodes/session-catalogs.md#owner-imports)               |
| Office documents open in the chat PDF reader through a converter route                                                                          | Control UI (`chat-office-preview.ts`, PDF reader, Files panel)                 | [Chat](docs/web/control-ui/chat.md)                                         |
| Claude Code prompt suggestions (`--prompt-suggestions`, `OPENCLAW_CLAUDE_PROMPT_SUGGESTIONS`) as composer ghost text, also in imported chats    | Anthropic CLI backend, `chat.prompt_suggestion` event, Control UI composer     | [Chat](docs/web/control-ui/chat.md#prompt-suggestions)                      |

The converter (`aiwb-office`) and the plugin that reports the effective settings (`aiwb-settings`)
live in [aiwb-plugins](https://github.com/SingularBunny/aiwb-plugins).
