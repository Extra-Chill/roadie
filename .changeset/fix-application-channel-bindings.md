---
"@extrachill/roadie": patch
---

Make send routing explicit application configuration. Remove directory-derived channel selection and automatic channel provisioning from `send`, including remote sends. Add an application default channel and fixed runtime directory to channel policy, shared by Discord and Slack, so repository work cannot create channels or move application sessions.
