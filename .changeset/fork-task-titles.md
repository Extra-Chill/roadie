---
"@extrachill/roadie": patch
---

Generate independent fork titles with a bounded small-model request containing only the new task prompt. Forks created without a prompt are named on their first message, including after restart. Exclude parent history, coding instructions and tools; limit input to 2,048 characters and output to 96 tokens. Preserve user-chosen titles and avoid replaying the inherited conversation.

Fixes #103.
