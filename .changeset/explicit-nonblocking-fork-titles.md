---
"@extrachill/roadie": patch
---

Use only the explicitly configured OpenCode agent.title.model or small_model for fork titles, removing catalog/name/price-based model guessing. Run title generation independently of task startup so slow or rejected naming requests never block the fork's work. Include the configured route and underlying API error in failure diagnostics, and synchronize native Slack fork headers when asynchronous titles arrive.

Fixes #109.
