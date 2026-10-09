---
"@extrachill/roadie": minor
---

Agent tool shells now reach every agent-facing `roadie` subcommand through scoped bot endpoints: `session list|archive|abort|title|editors|discord-url`, `task delete`, `project add|create|remove|open-in-discord`, `thread list` and `user list` join the commands moved in the previous release, so isolated shells (`--isolate-shells`) keep the full agent CLI. Bot administration (`bot`, `credentials`, `upgrade`, `discord-install-url`, `session export-events-jsonl`) is operator-only and refuses in agent mode. The bot's CLI child now uses the bot's own data directory (it previously fell back to `~/.roadie` when the bot ran with `--data-dir`) and loads TypeScript sources reliably when running from source.
