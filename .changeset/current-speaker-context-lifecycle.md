---
"@extrachill/roadie": patch
---

Keep pinned host context shared, and resolve speaker-specific context on first turns, speaker changes and session reconstruction. Include the authenticated chat space in context requests and retry empty context lookups on later turns.

Fixes #102.
