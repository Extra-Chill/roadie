# Host prompt configuration

Hosts customize built-in guidance through `ROADIE_PROMPT_CONFIG`, a YAML or JSON file with `disable`, `replace`, and `append` entries. Unknown section IDs are warned about and ignored.

Keep `commands` for a compact, platform-neutral CLI reference even when disabling all policy and formatting guidance. Its shell examples use the agent environment rather than pinned session or channel IDs. Upload, archive, title and fork select the current session in agent shells; search defaults to the current project. Read and wait require an explicit target session ID. Send destinations are explicit shell variables so new-thread and existing-thread modes stay distinct.

Built-in section IDs:

- `commands`, `session`, `discord-output`, `permissions`, `upgrading`, `debugging`
- `file-upload`, `file-request`, `sleep`, `archive`, `abort`, `title`, `mentions`
- `send`, `scheduled-sends`, `cwd`, `reading-sessions`, `cross-project`, `waiting`, `submodules`
- `markdown`, `callouts`, `urls`, `diagrams`, `questions`, `channel-topic`, `model-rotations`
- Slack guidance: `chat-output`, `identity`, `interaction`, `automation`, `agents`

The scheduled-task context is included in `sleep`, not a separate section. Sections vary by platform. `session` holds session metadata; bash needs no additional prompt fields.

Example:

```yaml
disable: [markdown, diagrams, callouts]
replace:
  permissions: Ask an admin about access problems.
append:
  - id: house-rules
    content: Never deploy on Fridays.
```

Replacement text replaces the entire section, including its heading. Append entries accept either `content` or a `file` path. Changes apply to newly pinned session prompts; existing session prompts remain stable.
