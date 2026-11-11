# Essential tool filtering

`cli/src/session-handler/essential-tools.ts` determines which tool parts are visible in `text-and-essential-tools` verbosity. Known read-only tools (`read`, `glob`, `grep`, `describe-media`, `todoread`, including namespaced variants) are hidden. Other tools, including bash and custom tools, are shown.

Pi's bash input schema accepts `command` and optional `timeout` in seconds. Bash visibility does not depend on extra input fields or inferred side effects.

`cli/src/session-handler/thread-session-runtime.ts` applies this filtering to streamed messages and tool notifications. `text-only` hides all tools; `tools-and-text` shows all tools. Channel verbosity is configurable through `/verbosity`.
