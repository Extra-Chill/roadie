---
"@extrachill/roadie": minor
---

ChatGPT subscriptions work in OpenCode credential pools (#198). The subrouter cutover used to leave a ChatGPT install with an empty pool and `roadie/openai-*` choices that failed with `no usable accounts in pool shared`. Now: `import-subrouter` and `import-opencode` import the `openai` OAuth login as an `openai-codex` account (deduped by ChatGPT account id) and `export-opencode` writes it back; a rotation entry `openai/<model>` is served by that subscription; the OpenCode pool provider serves it on ChatGPT's Codex Responses endpoint, reshaped the way the backend requires (instructions, `store: false`, no output limit, always streamed); and the startup migration only repoints a `subrouter/<preset>` choice when a pool account can serve the rotation.
