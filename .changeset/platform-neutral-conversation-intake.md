---
"@extrachill/roadie": minor
"discord-digital-twin": patch
---

Add a shared conversation intake policy for Discord and Slack, separating initiation, continuation, participant admission and context-only messages. Persist authenticated starters and participants across restart, and expose a typed host filter for response/admission decisions while preserving platform and host eligibility checks.

Keep context-only messages data-only: record them without starting work, changing the active actor/model/permissions, loading personal context or canceling a planned wake. Preserve native mention metadata in the Discord test twin.

Related to #27.
