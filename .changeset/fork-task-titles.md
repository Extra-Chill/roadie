---
"@extrachill/roadie": patch
---

Name forks from their new task prompt instead of inheriting the source conversation title. Forks created without a prompt are named on their first message, including after restart. Naming uses a bounded prompt preview with no extra model calls or history replay.

Fixes #103.
