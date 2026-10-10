---
"@extrachill/roadie": patch
---

Restore subrouter's full Claude Code signature in the credential-pool Anthropic OAuth adapter, so Claude Pro/Max subscription accounts keep working after the subrouter handoff instead of failing with HTTP 400. The system prompt now has opencode's identity blocks (`You are OpenCode, …` and the subagent `You are powered by the model named …` with their `<env>` block) replaced by a compact Claude-Code-style `<environment>` block that keeps the working directory, behind the `You are Claude Code` identity, mirroring `sanitizeSystemText` in `@subrouter/cli`. Requests whose body arrives on a `Request` object are shaped too instead of going out unsigned, model-dependent betas follow the model in the request payload, and OAuth token requests identify with the `claude-cli` user-agent.
