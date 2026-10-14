---
"@extrachill/roadie": minor
---

Manage a remote credential pool's accounts from the bot (#238). A pool host now serves an admin API under `/roadie/pool/admin/` for clients registered with `roadie credentials client add <name> --admin`, limited to the client's own pools. A bot with `ROADIE_POOL_URL` and `ROADIE_POOL_ADMIN_KEY_FILE` runs `/credentials`, `/login` and `roadie credentials list|add-key|login|remove` against the host: the OAuth code exchange happens on the host and no key or token reaches the bot. Without an admin key those commands name the host and the fix and write nothing locally. All account management, local and remote, goes through one `PoolAccounts` seam with a secret-free account view. `roadie credentials login` also accepts `openai-codex`.
