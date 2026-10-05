---
"@extrachill/roadie": minor
---

Add shared/separate workspace selection to session forks, with a host-provided fork_workspace hook. Persist isolated workspace bindings across restart, report their committed base, and stop before creating or running the fork when provisioning fails. Hosts retain workspace creation and cleanup ownership.

Fixes #106.
