---
"@extrachill/roadie": minor
---

Credential pools phase 1a (global mode, API keys, opt-in). Start roadie with `--credential-pools` or `ROADIE_CREDENTIAL_POOLS=1` to manage API keys as pools under `<dataDir>/credentials/` (`roadie credentials list|add-key|remove|rotation set`) and expose the shared pool's rotations as `roadie/<rotation>` models in the OpenCode backend. Requests are tagged per session via a `chat.headers` hook, a pool-aware provider fetch picks the account per request, strips all `x-roadie-*` headers, rotates to the next account on 429 (honoring `retry-after`, else 60s), and fails closed with 401 when no pool or account is available. With the flag unset the generated OpenCode config and behavior are byte-for-byte unchanged; subrouter is untouched.
