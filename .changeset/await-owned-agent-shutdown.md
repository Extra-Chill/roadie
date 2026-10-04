---
"@extrachill/roadie": patch
---

Wait for owned OpenCode processes to close before releasing their state and files. Bound shutdown with a graceful deadline and awaited SIGKILL escalation, and prevent intentional escalation from triggering an automatic server restart.

Related to #94.
