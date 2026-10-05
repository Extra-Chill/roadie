---
"@extrachill/roadie": patch
---

A restart continuation that the agent backend aborts before it produces anything is re-sent once. If that attempt is aborted too, the thread gets a notice ("Roadie restarted and couldn't resume this run; send a message to continue") instead of going silent. The OpenCode server now logs at INFO into a size-capped `opencode-server.log` in the data directory, so the cause of a backend abort is on record; set `ROADIE_OPENCODE_LOG_LEVEL` to change the level. An abort Roadie did not request is logged as coming from the agent backend.

Fixes #100
