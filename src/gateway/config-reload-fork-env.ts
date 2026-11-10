/**
 * Fork: environment variables that only the fork reads, each when it is used rather than once at
 * start. A config `env.vars.<NAME>` (or `env.<NAME>`) change of one of them publishes the new
 * process.env without a Gateway restart; every other env change keeps upstream's restart.
 *
 * Where the value takes effect:
 * - utility cadence, Claude CLI switches, plugin Gateway grants, catalog limits and owner imports:
 *   on the next use (the next digest, recap, CLI run, request or import);
 * - OPENCLAW_WORKER_PENDING_*: on the next queue admission; OPENCLAW_WORKER_HEAP_MB: for workers
 *   started after the change (running workers keep their heap ceiling);
 * - OPENCLAW_MEMORY_INDEX_ON_START: read when the memory index service starts, so on the next start;
 * - OPENCLAW_RESTART_AGENT_RUN_WAIT_MS: on the next restart deferral;
 * - OPENCLAW_PROXY_ROUTES: on the next connection (the managed proxy itself, `proxy.*`, still
 *   needs a restart); OPENCLAW_CLI_BACKEND_PROXY: on the next CLI backend run;
 * - OPENCLAW_ASSISTANT_MEDIA_ROOTS: on the next chat file preview or download.
 */
export const FORK_HOT_ENV_VARS = [
  "OPENCLAW_WORKER_PENDING_TASKS",
  "OPENCLAW_WORKER_PENDING_BYTES",
  "OPENCLAW_WORKER_HEAP_MB",
  "OPENCLAW_CATALOG_CONTINUATION_MAX_ITEMS",
  "OPENCLAW_CATALOG_CONTINUATION_MAX_BYTES",
  "OPENCLAW_CATALOG_IMPORT_OWNER",
  "OPENCLAW_CLAUDE_PROMPT_SUGGESTIONS",
  "OPENCLAW_CLAUDE_CHROME",
  "OPENCLAW_PLUGIN_GATEWAY_METHODS",
  "OPENCLAW_MEMORY_INDEX_ON_START",
  "OPENCLAW_SESSION_OBSERVER_MIN_INTERVAL_MS",
  "OPENCLAW_ACTIVITY_RECAP_MIN_INTERVAL_MS",
  "OPENCLAW_RESTART_AGENT_RUN_WAIT_MS",
  "OPENCLAW_PROXY_ROUTES",
  "OPENCLAW_CLI_BACKEND_PROXY",
  "OPENCLAW_ASSISTANT_MEDIA_ROOTS",
] as const;

/** Both config spellings: `env.vars.<NAME>` and the `env.<NAME>` shorthand. */
export const FORK_HOT_ENV_RELOAD_PREFIXES: readonly string[] = FORK_HOT_ENV_VARS.flatMap((name) => [
  `env.vars.${name}`,
  `env.${name}`,
]);
