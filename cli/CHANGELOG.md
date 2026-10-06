# Changelog

## [0.41.6] - 2026-10-06

### Changed
- align model validation fixtures with active providers

### Fixed
- retain host runtime providers across isolated forks

## [0.41.5] - 2026-10-06

### Fixed
- remove conversation scanning from fork ownership

## [0.41.4] - 2026-10-05

### Fixed
- resolve fork coding scope outside the conversation home
- automatically isolate configured conversation forks

## [0.41.3] - 2026-10-05

### Fixed
- acknowledge fork interactions before slow setup

## [0.41.2] - 2026-10-05

### Fixed
- preserve fork task titles across restart recovery

## [0.41.1] - 2026-10-05

### Fixed
- use explicit title routing without blocking fork tasks

## [0.41.0] - 2026-10-05

### Added
- add host-provisioned fork workspace selection

### Fixed
- bind fork worktrees through native workspace discovery

## [0.40.0] - 2026-10-05

### Added
- bind application channels through Discord commands

## [0.39.0] - 2026-10-05

### Added
- share conversation intake and durable participant admission

## [0.38.4] - 2026-10-05

### Fixed
- bind sends to application channels and runtime directory
- generate fork titles with a bounded prompt-only small-model request
- name forks from their new task prompt without model calls

## [0.38.3] - 2026-10-05

### Fixed
- keep host speaker context turn-scoped across session recovery

## [0.38.2] - 2026-10-05

### Fixed
- re-send a restart continuation the backend aborts, never leave the thread silent

## [0.38.1] - 2026-10-04

### Fixed
- footer shows a self-named subrouter preset once and no late context notice

## [0.38.0] - 2026-10-04

### Changed
- busy threads take messages at the next step boundary; remove /queue and the interrupt

## [0.37.0] - 2026-10-04

### Added
- add native Slack runtime and shared project context

### Fixed
- narrow process-group test PID output before parsing
- skip member lookup for webhook posts; log why a member fetch failed
- stop the OpenCode server's whole process group and wait for it to exit
- generate both chat twins for release packaging
- await owned agent shutdown before releasing state

## [0.36.0] - 2026-10-04

### Added
- host_upgrade hook for managed installs

## [0.35.1] - 2026-10-04

### Changed
- don't pin the queue position in the /queue ordering snapshot

## [0.35.0] - 2026-10-04

### Added
- backend-neutral subagent primitive with child-session events

### Changed
- disable OpenCode per-step snapshots

## [0.34.1] - 2026-10-04

### Fixed
- derive custom-dir lock ports below the OS ephemeral range

## [0.34.0] - 2026-10-04

### Added
- Roadie-owned permission policy

### Changed
- /login runs on Roadie-owned auth operations
- /model picker on the backend catalog; remove /resume

## [0.33.1] - 2026-10-04

### Changed
- Roadie-owned model and agent catalog on the backend seam

## [0.33.0] - 2026-10-03

### Added
- plugin API with WordPress-style filters and actions

## [0.32.0] - 2026-10-03

### Added
- release Roadie as an installable GitHub release tarball
- Roadie agent events and the OpenCode translator
- service mode with orphan cleanup, restart continuation, managed installs
- headless config and service-token local send
- context provider hook (generic memory API)
- composable system prompt with host overrides
- per-channel policy for who, when, threads, directory, agent and capabilities
- identity hook maps chat users to people with per-person capabilities
- export per-turn actor and thread attribution to tool processes
- ack side questions immediately while forking
- allow disabling completion footer mentions
- add --opencode-hostname and --opencode-port for VPS attach
- add --question-timeout-minutes for AskUserQuestion dropdowns
- add persistent kimaki_sleep tool for hours-long session waits
- upgrade transcribe fallback to whisper-large-v3-turbo
- free Whisper transcription fallback via kimaki.dev Workers AI
- add --no-analytics and drop dead --no-sentry
- edit scheduled task model/agent and fix thread membership
- auto-resolve best remote ref for worktree base branch
- allow /new-session command in threads with inherited working directory
- show session ID alternative in parentheses alongside thread ID
- add --all flag to project list for cross-machine discovery
- validate file attachments and attach long prompts as prompt.md
- prefer --thread over --session in system message for cross-machine compatibility
- add --file option to kimaki send for attaching local files
- show guild name in project list, add project remove command
- add Run now button to /tasks for planned scheduled tasks
- pass parent session id when spawning child sessions
- add mention-prefixed thread messages to session context without triggering AI
- allow kimaki send --notify-only to target arbitrary Discord channels
- add `kimaki session abort` command and print session ID from `kimaki send`
- add bindClient to plugin logger for dual file+opencode logging
- auto-reject permission requests in subagent sessions
- add contextual feedback message on permission timeout
- add configurable permission timeout and enable continue on deny
- show Discord notification when user edits or removes a queued message
- support editing queued messages via Discord message edits
- restrict /login and /transcription-key to admin-only when --allow-all-users is active
- add kimaki-demo Fly.io deployment for public demo server
- add --allow-all-users flag to bypass role/permission checks
- add one-shot prompt support to quick agent commands (/xx-agent)
- use git worktree list as source of truth for /worktrees command
- shorten worktree paths and folder names
- add --enable-skill / --disable-skill to filter injected skills
- add --cwd option to kimaki send for reusing existing worktree directories
- add image optimizer plugin to prevent oversized image API errors
- detect leading /command in user prompts and route to opencode command API
- auto-rename Discord threads from OpenCode session titles
- run dependency install after worktree creation, queue messages during pending
- show detected agent indicator after voice transcription
- add /btw slash command — fork session with full context and send a new prompt
- drain local queue immediately after question answered via select menu
- add legal pages for Discord verification
- reclaim external sync when user resumes from OpenCode CLI
- validate slack install inputs with Spiceflow
- switch live voice sessions to Gemini 3.1 Flash Live
- convert to spiceflow RSC on Cloudflare Workers
- typing indicator, Sync: prefix, discord-user metadata
- clean up SQLite when Discord channels are deleted
- add libsqlproxy package — runtime-agnostic Hrana v2 HTTP server for SQLite
- re-register Discord slash commands on /restart-opencode-server
- add /memory-snapshot Discord command
- add paginated select menus for /model and /login commands
- add `task edit <id>` CLI command for editing planned task prompt and schedule
- unify service auth token and wire reachable wake flow
- add /screenshare command — VNC + websockify + tunnel
- run Linux bridge tests in real desktop session and enforce strict contract
- switch client constructor to object input
- switch to errore-style typed failures and rename package
- add suspendMachine, memory, and org-level listing
- vendor fly-admin as workspace package
- unify VM scripts, harden Linux X11 screenshot, fix zig version
- add UTM VM test runner and vm:exec command
- extend gateway clients for Slack bridge tenants
- route Slack bridge traffic through per-client runtimes
- add KV-backed gateway client cache for Slack installs
- add egaki and resync upstream skill docs
- route source prisma exports by runtime
- export plain library helpers for computer-use harnesses
- add coord-mapped debug-point workflow
- add CLI rendering and debug overlay helpers
- add native scroll backend and window listing
- simplify client routing and bootstrap preview mapping
- scale screenshots and add coord-map remapping for pointer actions
- route traffic by client durable object
- add native text typing and key combo synthesis
- simplify slack gateway routing and harden bridge runtime startup
- ship npm-ready macOS package with real screenshot capture
- implement real macOS mouse events and intuitive coordinate flags
- add gateway session manager and native usecomputer scaffold
- add block_suggestion autocomplete bridge and typed interactive payloads
- route slash commands through modal-backed option mapping
- improve demo bot UX and Slack interaction parity
- add event-sourced thread typing bridge
- add callback-based auth and explicit unauth route policy
- add Slack parity for attachments and thread APIs
- improve error descriptions and align thread/event parity tests
- add message thread endpoint and structured API errors
- e2e tests + snowflake-compatible IDs + AGENTS.md docs
- add e2e test infrastructure for discord-slack-bridge
- complete event, interaction, and REST spec parity
- support all Discord message select components
- add initial Slack bridge and digital twin foundation
- SSE event protocol for programmatic gateway mode
- mention installer in welcome thread
- welcome thread, DB-only channel detection, Bun tutorial
- support ". queue" suffix in regular messages
- add welcome message and tutorial plugin for default kimaki channel
- create default kimaki channel for general-purpose tasks
- non-TTY gateway mode with JSON event protocol
- add `kimaki bot` command group with status set/clear and install-url
- include client_id in gateway callback URL redirect params
- add --gateway-callback-url CLI option for custom post-OAuth redirect
- pass current agent to system message examples and agent list
- add HTML action buttons to worktree tables
- add /model-variant command for quick thinking level switching
- add base-branch and target-branch autocomplete to worktree commands
- add explanation line for external_directory permissions
- add /mcp command for MCP server management
- include thread starter message in .text() and getMessages()
- add created_at field to gateway_clients
- add 2-hour idle threshold before stopping servers
- always show critique diff at end of session
- smart bot selection when multiple bots exist in DB
- use agent name instead of 'task' prefix in Discord messages
- delete legacy global slash commands on guild registration
- support gateway install URL mode
- add gateway-aware discord-install-url command
- explain unlinked channels on explicit mentions
- add idle runtime/server cleanup and stop-opencode-server
- add VITEST_CPU_PROF env var for vitest cpu profiling
- add profano — CLI tool to analyze .cpuprofile files
- deterministic footer placeholders and typing event tracking
- complete text() snapshot coverage in messages.test.ts
- add text() method to ChannelScope for thread snapshot debugging
- add multi-guild support and gateway URL override
- add 'queue this message' voice intent detection + queueOrSendMessage abstraction
- move log file to data directory (~/.kimaki/kimaki.log)
- add simplify, batch, and security-review skills extracted from Claude Code CLI
- make interrupt handling immediate and stabilize queue e2e with deterministic provider
- abort running session at step-finish when next message is queued
- add Phase 5 guild management routes + README
- add cached OpenCode provider proxy workspace package
- strengthen memory compliance with synthetic reminders and mandatory instructions
- add Prisma relations for scheduler and forum config tables
- add scheduled send/task automation and session origin tracking
- gate memory features behind explicit --memory flag
- add global memory scope with forum tagging
- replace forum-sync.json with SQLite table, auto-create memory forum channel
- scope memory by project channel ID and add forum sync subfolder support
- add persistent memory folder with system prompt instructions
- add forum markdown sync engine
- show Discord channel name and folder name in project list
- dismiss action buttons when user sends a new message
- add kimaki_action_buttons tool for quick Discord button confirmations
- add /session-id command and remove footer session id
- add session search for past project conversations
- warn on detached git states in branch context
- inject synthetic parts for branch detection and idle-time awareness
- show skill tool calls in essential tools verbosity
- add --verbose-opencode-server flag for debugging server output
- add errore/zele/critique skill sources and only copy SKILL.md for repo-root skills
- add skills paths to opencode config and include skills in package
- inject V8 heap snapshot flags into child process
- add sync-skills script to clone and discover skills from remote repos
- increase bash command inline display threshold from 50 to 100 chars
- make `kimaki upgrade` restart the running bot after upgrading
- store model variant in model tables with session/channel/global cascade
- enable SQLite WAL mode and busy_timeout
- add --wait flag to kimaki send command
- add /queue-command slash command for queueing user commands
- add /context-usage slash command
- add `project open-in-discord` command, remove outer try/catch from project commands
- improve quick agent command replies with previous agent, model, and already-using check
- show current agent in /agent command reply
- add kimaki_file_upload tool - Discord native file picker
- show exit code and loading message for ! shell commands
- add kimaki self-upgrade support
- auto-detect and install OpenCode + Bun at startup with Windows support
- add ! prefix shortcut for shell commands in Discord messages
- centralize permission checks and enforce on all interactions
- add /run-shell-command Discord command
- render tables as Discord Components V2 instead of code blocks
- move session list/read from plugin tools to CLI commands
- auto-upgrade opencode in background on bot startup
- add mention-only mode for channels
- shorten session preview
- save long session output to tmp
- use squash merge with descriptive commit message
- add project directory to external_directory permissions
- add --agent and --model options, markdown tip in system message
- add --user option to add user to thread and discord_list_users tool
- allow worktree sessions to access original repo directory
- add --worktree option to create git worktree for session
- add /unset-model-override command
- add global model setting for /model command
- add messagediff tool via opencode plugin
- add preview deployment environment
- add external_directory permissions with dynamic tmpdir
- always pass explicit model to OpenCode like TUI does
- add no-kimaki role to block users from bot access
- add text-and-essential-tools verbosity level
- add discord username prefix to AI prompts and ignore non-bot mentions
- make verbosity apply mid-session and add --verbosity default flag
- add /compact command to trigger session context compaction
- spawn caffeinate on macOS to prevent system sleep
- display rate limit status in Discord when OpenCode is retrying
- display apply_patch tool like edit with square icon and file summary
- transfer uncommitted changes to worktree when using /new-worktree in threads
- add /verbosity command for text-only mode
- add /new-worktree support for existing threads
- check for uncommitted changes before merge
- add /enable-worktrees and /disable-worktrees commands
- handle detached HEAD and use detached after merge
- switch worktree to main after merge
- add /merge-worktree command with ⬦ thread prefix
- add add-project command and worktree submodule/deps init
- add --use-worktrees flag for automatic worktree sessions
- handle 2000 char limit in send command, add handoff docs
- add /new-worktree command and rename /session to /new-session
- migrate errors to createTaggedError factory
- add quick agent commands and fix agent model switching
- remove message prefixes, use database for auto-start detection
- add --notify-only flag and fix multi-bot guild selection
- add /remove-project command and --project option for start-session
- unnest code blocks from lists for Discord compatibility
- add --install-url CLI option to print bot invite URL
- auto-create Kimaki role on CLI startup
- add start-session CLI command for programmatic session creation
- add --data-dir option for multi-instance support
- support user-defined opencode commands as discord slash commands
- graceful shutdown with SIGTERM before SIGKILL, add /stop alias
- abort and retry with new model on mid-session model change
- add file logging in dev mode
- add lowercase capitalization rules to system prompt
- auto-kill existing kimaki instance instead of failing
- trigger notification badge on session completion message
- add /undo and /redo commands for session history
- add /clear-queue command to clear queued messages
- show last assistant message in fork and fix resume newlines
- add /queue command to queue messages during active sessions
- add /model command and fix interaction timeouts
- add permission request handling with /accept, /accept-always, /reject commands
- add SIGUSR2 restart handler and batch assistant messages

### Changed
- db migration tests use their own temp dir instead of cli/tmp
- root test script generates schema clients before running unit tests
- one /fork command replaces /btw and the btw suffix
- drop git submodules and the libsqlproxy copy for their npm releases
- Roadie-owned session operations on the agent backend seam
- runtime event handlers and part rendering run on Roadie agent events (#55 part 3)
- wait for /queue to enqueue before asserting in the abort test
- event buffer and derived session state run on Roadie agent events
- scope the service token to a send endpoint instead of database access
- keep test lock ports below the OS ephemeral port range
- remove /undo and /redo
- retry e2e data dir removal while the agent server finishes writing
- remove external session sync into Discord
- unique e2e channel ids so parallel files never share a lock port
- chat platform seam for the session runtime's thread operations
- agent backend seam owns the event stream and restarts
- bound the plugin-loading health wait and surface server stderr
- thread working directory replaces worktree bindings
- remove the remaining kimaki.dev references
- stop bundling skills
- subrouter as a pinned dependency; retire legacy OAuth rotation
- warm the OpenCode instance before e2e suites run
- remove unused upstream packages and docs
- remove tunnels, screenshare, vscode, share, memory snapshots and the game tutorial
- clean break from Kimaki install compatibility
- hand worktree create and merge to host tooling
- remove voice support
- remove Kimaki's MEMORY.md system
- remove forum sync
- remove hosted gateway mode
- remove critique.work diff uploads
- remove Strada product analytics
- give vitest runs a temp SUBROUTER_HOME
- route session runtime through an AgentBackend seam
- rename Kimaki to Roadie with full Kimaki compatibility
- kimaki@0.31.0
- require fresh clone before reading
- system prompt: show found sessions as Discord thread links
- remove proactivity rules from system prompt
- Rebalance agent guidance and correct CLI database instructions
- Reduce the fixed Kimaki system prompt for new sessions
- Move task-specific Kimaki guidance into an agent reference
- Document queue and btw suffixes for sent follow-ups
- Detect prompt cache misses on the first btw fork reply
- Queue btw forks after earlier prompts finish
- Post the /queue ack inside the serialized enqueue so drain replies always target it
- Reply silently to the queuing message when a queued prompt starts
- Honor the queue suffix in /new-session and /queue prompts
- Pin session system prompt so btw and fork reuse the prompt cache
- Honor the queue suffix for every kimaki send path
- Use @strada.sh/sdk 0.8.0 for analytics
- Use @strada.sh/light for anonymous CLI analytics
- Discard experimental footer re-add notification flow
- Keep multiline progress text full-width and refresh reply snapshots
- Use derived labels when rendering child tool calls
- Label child tools only after task metadata arrives
- Show estimated input mix in context usage
- kimaki@0.30.1
- Link the parent thread in threads started with --parent-session
- Make /abort also clear the thread /queue
- Show prompt cache miss notice after the first reply of each message
- Show tool calls and bot status lines as Discord subtext
- Bump subrouter to 7a54825 for Claude Code user-agent on OAuth token requests
- Mark Discord system lines with -# subtext instead of quotes or diamonds
- Show system prompt diff in prompt cache miss notices and save .patch files
- Add getPromptCacheClear derivation for mid-session prompt cache misses
- Advertise Claude Code 2.1.280 on Anthropic OAuth requests
- Make footer mentions opt-in with --enable-footer-mentions
- Unquote the last Discord text when a turn ends.
- Move session-read duration after the last assistant reply
- Keep queued Discord messages waiting while a task subagent is still running.
- Drop per-turn session-read frames; keep one user duration
- Compress kimaki session read markdown for later agents
- Document opensrc cache refresh behavior
- Update voice transcription model IDs
- Stop session waits at pending questions
- Keep autonomous task runs out of the sidebar
- Resume aborted sessions with question answers
- kimaki@0.29.0 and @kimaki/automode@0.2.0
- Enrich `kimaki session list` with status, tokens, and --all
- Keep /queue messages in SQLite across bot restarts.
- Give each Kimaki machine its own Discord group.
- Tell agents to skip session title on the first turn.
- Show Discord thread ID in /session-id.
- Prevent synthetic user context from leaking into Discord
- Refresh the lockfile after kimaki@0.28.0.
- Read Subrouter auth.json in the plugin-loading e2e test.
- Show the OpenCode SDK error when session create fails.
- Keep Discord sessions from being reclaimed as TUI sync.
- Keep /btw forks from freezing Discord updates in the parent thread.
- Reject OpenCode 2.x before Kimaki starts the shared server.
- Ignore the local nested Subrouter OpenCode v2 plugin checkout.
- Quote short Discord text immediately and restore readable prefixes.
- Drop the unpublished local-channel setup changeset.
- Add a changeset for quieter Discord agent turns.
- Add a private read-only React node-graph package.
- Silence footer notifications after sleep turns
- Require local channel ownership for Discord setup commands.
- Limit kimaki session search to the last 14 days by default.
- Flush live Discord tool parts during a turn.
- Replace Discord line prefixes with CJK radicals.
- Quote the new-session model banner in Discord.
- Fail `kimaki project add` when the folder is already registered.
- Bump Traforo for hidden kimaki.dev backlinks
- Bump Subrouter for provider timeout retries
- Bump errore after compressing the SKILL.md
- Add a Discord colored text generator to the website
- Add OpenCode v2 Kimaki plugin migration plan
- Document Discord leftover slash text filling the first option
- Call matchThinkingValue directly in session variant apply
- Separate Discord text and tool parts with a blank line
- Hold Discord parts until compaction summary identity is known
- Remove the standalone oscilloscope package.
- Add an optional variant option to xxx-agent slash commands.
- Soften the homepage Discord playground window corners.
- Replace CSS oscilloscope knobs and switches with image textures.
- Prefer known users over thread member fetch in footers.
- Skip bot mentions in final session footers.
- Soften the kimaki tunnel system prompt.
- Match homepage H1 to title without repeating Kimaki.
- Require explicit voice chat creation and preserve source sessions
- Quote the homepage title so YAML keeps Kimaki as the page title.
- Add voice routing to side chats and fresh sessions
- Add interactive analog oscilloscope recreation
- Tell agents the kimaki_sleep tool result is not a wake
- Tell agents to upload Discord images instead of markdown
- Rewrite the homepage Discord playground around real Kimaki sessions
- Add e2e coverage for leftover abort text before a question dropdown
- Show ignored plugin notices as silent bot messages
- Explain that btw: titles are side sessions, not duplicates
- Assign the bash tool jsonSchema from a Zod object
- Put a Separator on both text-and-tool transitions
- Restore default session footers and mention the thread creator
- Polish the homepage Discord playground and add a Mintlify dither field.
- Add an interactive Discord playground to the homepage hero.
- Advertise description and hasSideEffect on the built-in bash tool
- Turn session footers off by default and ping in the final reply
- Limit the ingress FIFO to one-shot agent and cmd slash calls
- Serialize agent and model preference writes with follow-up Discord messages
- Replace diamond text prefixes with a separator before tools
- Bump Subrouter for encrypted reasoning replay
- Move undo-redo e2e off lock port 51767 held by workerd
- Return Discord 404 for unknown channels through the gateway
- Bump Traforo after dropping Playwriter tunnel routes
- Show the live Subrouter model in /model and footers
- Bump Subrouter for live session routes and GPT apply_patch
- Add a cpuprof stdin command for live CPU profiles
- Skip interrupt abort for ignored context notices
- Add kimaki session search --all for every local project
- Harden part_messages orphan cleanup against NULL parent keys
- Scheduled task section: drop the archive-the-thread instruction
- Delete orphaned part_messages rows on database startup
- Add scheduled task context to the session system message
- Allow omitting --user on scheduled tasks and clear it with task edit --user ''
- Harden OpenCode auto-mode skip and classifier paths
- Add OpenCode auto-mode plugin that gates tool execution
- Advance Subrouter for identity, stream errors, and notices
- Ignore Subrouter display-only fallback notices in Discord sync
- Use the current Claude Code client identity
- kimaki@0.27.0
- make packaged skill sync reliable
- align Subrouter plugin integration expectations
- align documentation dependencies and submodules
- reduce slow and redundant integration coverage
- Document ground-truth session bug reports
- Drop stale questions after a newer user turn
- Avoid an extra model-list request for the session banner
- Stop aborting task subagents on provider rate limits
- Keep next kimaki publish typechecking after the opencode-go rename.
- Point the traforo submodule at close-handshake and docs layout commits.
- Point the subrouter submodule at the opencode-go provider rename.
- Show preceding assistant text before the question dropdown
- Link the self-restart hang recovery changeset to #190
- Add Kimaki visual design notes for generated graphics
- Document kimaki-demo Fly deploy and bump demo image pins
- Print Error.cause chains in Kimaki logs
- Always pass --hostname so OpenCode cannot bind 0.0.0.0
- Mention the thread creator in the final session footer
- Validate --model against the live OpenCode model list
- Migrate leftover session_sleeps columns on existing databases
- Use OpenCode session title as the only source of truth
- Show git command, exit code, and stderr when merge-worktree fails
- Add kimaki session title for OpenCode and Discord thread names
- Add session editors tracking for file edits
- Count task child session tokens in Strada tokens_used events
- Show queued subagent tasks in Discord
- Expose worktree merge CLI and auto-retry conflicts
- Simplify worktree identity validation
- Add Subrouter subscription routing to Kimaki
- Add squash strategy to worktree merges
- Clean failed worktree workspace state
- Add active session listing for agent coordination
- Bump subrouter submodule: @subrouter/cli rename, docs site, merged AGENTS.md
- Bump subrouter submodule: codex payload fixes + AGENTS.md
- npm-package skill: ban rm -rf and any delete from build scripts
- Add subrouter as submodule
- Recommend .ts/.tsx extensions in relative source imports
- simplify sleep delivery to one retry path and no stored thread
- Pin force-kill to the child generation that received the signal
- Force-kill the bot process when self-restart hangs on process.exit
- kimaki@0.26.0
- Save Discord text attachments locally instead of filling context
- Declare spiceflow vite peer in packageExtensions
- Require question and button tools after all text
- Add --pre-run and non-overlapping scheduled tasks
- Track billed token usage on session idle for Strada
- Show localhost next to kimaki tunnel URLs
- Refresh /agent even when the same agent is already selected
- Add xAI (Grok) multi-account OAuth rotation
- Allow every directory by default, remove /add-dir
- restore /model-variant and /clear-queue slash commands
- kimaki@0.24.0
- add changeset for missing analytics module source-build fix
- report website server and browser errors to strada
- add anonymous product analytics to the cli
- add @strada.sh/sdk dependency to cli and website
- free Discord command slots by moving secondary actions to buttons
- improve abort command discoverability
- support disabling default channel creation
- update demo to kimaki 0.23.1
- remove stale skills from published bundles
- clarify OAuth callback paste action
- Remove Anthropic OAuth accounts on permanent refresh failure
- /clear-queue now lists the cleared messages
- Pre-install opencode in demo Dockerfile to avoid runtime fetch failures
- enable Exa web search tool by default for all kimaki sessions
- Delete batch and simplify skills
- Delete security-review skill
- Skip recreating default kimaki channel if user previously deleted it
- omit scheduledTaskId from one-shot task markers
- delete one-shot scheduled tasks after they run
- Add kimaki merge-worktree instruction to worktree system message
- add task deduplication guidance to system message
- scheduled tasks: prefer short prompts with task md files in repo
- kimaki@0.22.0
- add Channel column to /tasks command table
- kimaki@0.21.0, @kimaki/opencode-plugin@0.1.0, discord-digital-twin@0.1.1
- stabilize full CLI suite
- remove critique review command from system message
- Add dedup guard to @kimaki/opencode-plugin
- Add @kimaki/opencode-plugin package for standalone Anthropic OAuth
- add pre-publish checklist rule: sync skills before npm publish
- kimaki@0.20.1
- fail fast when files exceed Discord upload size limit
- add description field to bash tool system prompt as TypeScript interface
- show custom/MCP/plugin tools in default verbosity mode
- kimaki@0.19.0
- compact session markdown export: hide tool outputs by default
- kimaki@0.18.0
- add deploy website after publish instruction to AGENTS.md
- use OpenCode workspace SDK for worktree management
- add comprehensive worktree e2e tests for channel-level and auto-worktree flows
- Add kimaki.dev docs fetching instructions to demo AGENTS.md
- harden gateway reconnect restart to survive sustained network outages
- Add inference proxy worker for Kimaki Pro
- remove spiceflow override, keep packageExtensions for @holocron.so/vite
- add local prisma dev database for website development
- document #Thread Title syntax for finding sessions by thread title
- restore ThreadChannel question types
- add cache drift detection plugin (log-only)
- add --no-auto-upgrade CLI flag to disable background auto-upgrade on startup
- KIMAKI_BOT_TOKEN env var takes priority over saved DB credentials
- add `kimaki bot token` command and CI automation docs
- update @holocron.so/vite to 0.21.0, reduce hero dot color to 70% opacity
- kimaki@0.17.1
- reserve text budget for truncation notice, harden groupBySeparator edges
- skip voice channel join when no Gemini API key is configured
- cover btw fork model preservation
- add xAI grok-composer-2.5-fast model to default injected opencode config
- redesign install-success page: minimal, no card/shadow, Vercel-style
- kimaki@0.16.0
- split long --notify-only messages instead of attaching as file
- enable gateway mode option in onboarding wizard
- kimaki@0.15.0
- pass parent session ID into btw-forked session context
- nn
- rename "Built by Tommy" section to "Battle tested every day"
- filter disabled skills from Discord slash command registration
- show clickable source thread link in fork/btw new thread messages
- remove broken subagent permission auto-reject code
- force exit after 50 failed gateway reconnect attempts
- cover subagent permission abort messaging
- Parallelize async operations in /btw and /new-worktree commands
- simplify cast from as unknown as to as any
- Update model-switching.mdx
- extract getOpencodeServerAuthHeaders helper, deduplicate auth logic
- pass OPENCODE_SERVER_PASSWORD to all createOpencodeClient call sites
- collapse single-statement instanceof Error blocks to one line
- replace deprecated tryAsync with .catch()
- kimaki@0.14.0
- update pnpm lockfile and website vite config formatting
- update new-skill SKILL.md repo format to owner/repo
- add worktree base branch and commit discovery instructions to system message
- clarify user is probably away in timeout message
- Add GitHub PR template and issue templates (bug report + feature request)
- prevent @username mentions in scheduled task prompts
- replace per-thread SSE listeners with single global event stream
- add full response body to ensureSession error/warn logs
- add troubleshooting docs page for /restart-opencode-server and /upgrade-and-restart
- Add strada repo to skills sync sources
- show thread notifications when queued messages are edited or removed
- Replace Three.js DottedVideoBackground with VideoBackgroundShader from @holocron.so/vite/mdx
- add user input prefix for button clicks, question answers, and file uploads
- Gateway 503 for stale auth + defense-in-depth REST token guard
- Block discord.js REST token nullification on 401
- Update gateway-proxy submodule: stale DB timeout 30s → 120s
- kimaki@0.13.1
- update @holocron.so/vite from ^0.16.0 to ^0.17.1
- Update README.md
- refresh e2e expectations for tool output
- await goke parser result
- Update cli.ts
- update kimaki-demo dockerfile, traforo submodule, and changeset issue ref
- improve ensureSession error logging with full diagnostic context
- change btw shortcut from prefix to suffix detection
- use caffeinate -s to prevent sleep on lid close (AC power only)
- Update traforo submodule pointer
- make state-changing slash commands non-ephemeral so all users see them
- Add changeset for --allow-mention flag
- Add --allow-mention CLI flag to control which Discord mention types the bot can trigger
- move all doc pages under /docs/ URL prefix
- Add holocron to skill sync sources
- Remove large "Kimaki" title from website hero section
- fall back to default agent instead of throwing when agent not found
- kimaki@0.12.0
- add prune-inactive-guilds maintenance script
- update traforo submodule: tighter port ignore patterns
- add full HTML document shell to /slack-install layout
- remove duplicate docs/ .md files, keep website/src/docs/ .mdx as single source
- add AGENTS.md to kimaki-demo with demo reminder instructions
- enable allowImportingTsExtensions in website tsconfig
- revert dot sizes to original (dotSize: 6, minDotSize: 1)
- add Three.js hero section to docs website
- add hidden class, convert to lists, remove emdashes
- update traforo submodule: fix inspector port detection
- add holocron docs to kimaki website
- remove kimaki opencode passthrough command
- add --disable-sync flag, per-directory timeout, and background sync docs
- revert pinned opencode binary
- revert pinned opencode binary, restore global install check
- serialize Discord polls and forwarded messages as text
- serialize Discord embeds as text in user messages
- test quick-agent prompt channel isolation
- make state-changing slash commands visible to all users in the channel
- Update fly.json
- kimaki@0.11.0
- add text-to-speech CLI command (`kimaki tts`)
- add peer dependencies and SSR bundle exclusion sections to npm-package skill
- kimaki@0.10.2
- Update AGENTS.md
- Update opencode.ts
- pin opencode binary to v1.14.41, download from GitHub releases on first run
- kimaki@0.10.1
- switch back from global event stream to per-directory event.subscribe
- remove skills from cli
- clarify GlobalEvent-to-Event cast comment with Sync* event details
- Update thread-session-runtime.ts
- Update pnpm-lock.yaml
- Let session wait finish on questions
- Add session wait command
- Resolve channel mentions without Discord fetches
- Update traforo tunnel helper
- Allow channel references to grant project access
- Support cwd subfolders for Kimaki sends
- Clarify Kimaki session routing guidance
- Clean CLI package build output
- Migrate Kimaki CLI database to Drizzle
- prefer per-commit critique URLs when user asks for diff after commits
- kimaki@0.9.1
- Allow tunnel port detection for dev server commands
- Quiet channel creation logs
- Document pending Kimaki release changesets
- Split terminal CLI commands out of entrypoint
- Extract email from OpenAI JWT, add debug logging to plugin
- Extract multioauth commands to separate file with goke .use()
- Unified multi-provider OAuth rotation plugin
- Remove redundant type assertions, property checks, and annotations
- Add isTruthy type guard in forum-sync to replace inline type predicates
- Use exported `Hooks` type from @opencode-ai/plugin directly
- Remove redundant `as Error` casts and explicit error type annotations
- Add `void` prefix to intentionally-unhandled promises
- Remove unnecessary `as TextChannel` casts across command handlers and utilities
- move personal skills to global opencode config
- Make Discord member lookup optional
- Add Discord thread starter content probe
- Handle Discord messages without readable content
- Persist synced Discord thread names
- Respect manual Discord thread renames
- kimaki@0.8.1
- Add null guards for Bun .json() across all fetch call sites
- Point submodules to their tracking branches
- Resume idle sessions after permission replies
- Use tsx for CLI development
- Update gateway proxy for Bun startup
- Use single quotes in kimaki send examples
- Keep CLI JSON output pipe-safe
- Require Kimaki callouts for important notices
- Document skill repository frontmatter
- Apply add-dir permissions to busy sessions immediately
- Update errore submodule instructions
- Simplify agent instructions source
- Document root skills folder
- Keep synced skills out of root skills
- Add last-sessions command
- show model and agent banner for opencode commands
- show model and agent as first message when creating a new session thread
- kimaki@0.7.1
- poll hrana eviction for up to 10 seconds
- avoid SIGKILL during hrana eviction
- sync spiceflow skill with typed fetch rules
- add sigillo skill
- assume bundled skills always exist in cli
- inline skill copy into package scripts
- make root skills the canonical source
- sync skill docs from upstream repos
- remove system prompt drift toast plugin
- add /fork-subagent thread for subagent sessions
- Improve callout guidance in the system prompt
- Simplify callout color guidance in the system prompt
- Add callout containers to Discord markdown rendering
- replace tmux guidance with bunx tuistory flows
- sync upstream terminal and automation skills
- support queue as a standalone final line
- readme info for npm packages
- Update new-skill and npm-package skills: prefer root README in workspaces
- Make /add-dir default to all directories
- Track OpenAI transcription requests in Kimaki
- Relax queue e2e hook timeouts for CI
- Revert "add bash tool for GenAI worker with remote skill loading"
- kimaki@0.6.0
- centralize appendToastSessionMarker so plugin toasts route to Discord
- Update anthropic-auth-plugin.ts
- Rebrand opencode → openc0de in Anthropic system prompt and allow ~/.config/openc0de directory
- allow common home toolchain caches by default
- replace gitchamber with opensrc
- remove openc0de thing
- ignore unscoped Discord toasts
- abort rate-limited subagent sessions
- simplify subagent rate-limit fallback plugin
- add subagent rate-limit model fallback plugin
- kimaki@0.5.0
- prevent worktree sessions from editing the main checkout
- update traforo submodule for frozen lockfile installs
- update opencode-injection-guard submodule for CI
- simplify /add-dir permission updates
- add /add-dir session permission updates
- kimaki@0.4.104
- kimaki@0.4.103
- preserve btw: and Fork: prefixes during OpenCode session title renames
- add pnpm workspaces and CI sections to npm-package skill
- support punctuation separators in btw prefix detection
- agents
- remove profano
- delete betterstack thing
- test sync /plan-agent model snapshot
- show model in /xx-agent quick-switch reply
- Add BTW message shortcut for side-question forks
- sync skills: add profano skill and update npm-package skill
- clarify scheduled task no-op cleanup
- make /new-worktree use the current local HEAD by default
- revert GenAI bash tool extraction
- extract GenAI bash tool and cache remote skills
- dedupe repeated question tool requests
- improve skill sync reliability and refresh skill docs
- add positional clear-queue support
- add anthropic current account command
- kimaki@0.4.102
- allow opensrc directory in opencode defaults
- kimaki@0.4.101
- refactor anthropic prompt rewriting
- add opencode go to providers for login
- Extract frozen memory overview plugin
- remove lintcn. I will use my global config instead
- remove brittle opencode command snapshots
- refresh cli send thread command snapshot
- kimaki@0.4.100
- kimaki@0.4.99
- migrate stored gateway proxy urls from xyz to dev
- kimaki@0.4.98
- remove downlevelIteration from shared tsconfig
- bump traforo submodule to kimaki.dev routing commit
- regenerate AGENTS.md after kimaki.dev instruction updates
- bump gateway-proxy submodule for kimaki.dev defaults
- update bridge and onboarding docs to kimaki.dev
- use kimaki.dev as CLI and onboarding default domain
- switch website defaults to kimaki.dev with xyz fallback
- Prefer current-agent kimaki send examples
- Add /vscode browser workspace tunnel
- delay system prompt drift detection
- remove latestPromptPath
- kimaki@0.4.97
- refine agentmap scope for initial kimaki context
- simplify worktree base selection to HEAD
- normalize generated agents markdown whitespace
- persist anthropic account identity across oauth rotation
- disable gateway onboarding mode. fucking discord verification process takes forever
- expose anthropic account CLI commands
- scope anthropic plugin toasts to the active session
- kimaki@0.4.96
- scope marked toasts to the matching session
- simplify saved system prompt filenames
- refine system prompt drift toast copy
- kimaki@0.4.95
- kimaki@0.4.94
- Truncate log args to 1000 chars to prevent giant log output
- Update system-prompt-drift-plugin.ts
- add system prompt drift detector plugin
- soften worktree directory reminder wording
- kimaki@0.4.93
- improve merge-worktree conflict resolution guidance
- show toast notification on Claude account rotation
- clarify agent switches apply on the next thread message
- document running opencode commands and switching agents via kimaki send
- increase footer truncation limit to 30 chars
- kimaki@0.4.92
- truncate folder and branch names to 15 chars in footer
- ignore subagent sessions in external sync
- kimaki@0.4.91
- remove automatic Kimaki Discord role reconciliation
- reduce external sync log noise
- sync bundled skill docs
- refactor anthropic auth state handling
- add Discord reply context to prompt ingress
- bring back colored clack logger output
- rename discord/ folder to cli/
- tighten MEMORY.md prompt instructions for conciseness
- simplify MEMORY reminder to latest assistant reply
- detect /command on any line instead of stripping prefixes
- Update package.json
- /merge-worktree: rebase instead of squash
- relax flaky voice question thread snapshot
- stabilize voice question session assertions
- update voice question queue snapshots
- remove terminal styling deps from shared logger
- use single root prepare script with --filter instead of per-package prepare:build
- Update new-skill: synced skills warning, better README example, singular title
- Rewrite new-skill SKILL.md as a best-practices guide for creating skills
- worktree merge: opencode/kimaki-see-that-right-now-voice-messages-have-the-ability-to-choose-if-to-queue-the-me
- Update goke to ^6.3.2
- Replace `e as Error` casts with proper Error wrapping using cause chains
- Add multi-account Anthropic OAuth rotation
- Update bin.ts
- auto enable auto-restart
- Delete bin.sh
- remove undici use
- Remove undici, @sentry/node; move @types/ws to devDependencies
- remove fragile bot-message count assertions and add null guard
- update typing e2e assertions to use position-based checks
- Update dependencies: replace js-yaml with yaml, replace @discordjs/opus with opusscript, update @libsql/client, marked, domhandler, htmlparser2
- Remove @openauthjs/openauth dependency, inline PKCE helper
- kimaki@0.4.90
- Wrap /btw prompt with side-question framing so forked session only answers the question and does not continue the parent task
- Add --projects-dir flag to `project create` subcommand
- Make CI-failing tests more robust
- Strip git branch context from markdown snapshots
- Bump retry to 3, revert echo wait to 500ms delay
- Increase CI-sensitive timeouts from 4s to 8s in question tests
- Remove frozen-lockfile, re-enable all tests, skip existing repos
- Exclude thread-message-queue from CI (reply ordering race)
- Exclude 2 question-interaction test files from CI
- Add --retry 2 for flaky e2e tests on CI
- Add CI workflow for integration tests
- Allow CLI-injected self-bot prompts without Kimaki role
- kimaki@0.4.89
- Normalize existing-thread CLI prompts to the start marker
- Update discord test snapshots after full suite refresh
- Add per-session injection guard support to kimaki send
- Revert "add one-shot add-directory preapproval"
- Revert "add thread-scoped directory preapproval command"
- migrate deterministic provider to AI SDK v3
- kimaki@0.4.88
- add e2e test for kimaki send --channel thread creation race
- add failing e2e test for missing finish field on opencode message.updated events
- Add opencode-injection-guard as kimaki dependency
- kimaki@0.4.87
- add gitchamber skill to sync sources
- kimaki@0.4.86
- kimaki@0.4.85
- kimaki@0.4.84
- remove forced gateway relogin (6fab3fd)
- add --projects-dir flag to set custom project directory
- update traforo submodule for port suffix tunnel ids
- harden screenshare tunnel sharing defaults
- Update screenshare start message with privacy warning and stop command hint
- Add critique annotations docs to skill and system prompt
- expose --kill flag on kimaki tunnel CLI and update all usage examples
- kimaki@0.4.83
- Update vite.config.ts
- logos
- Add standalone Better Stack traces app
- use global session list endpoint, reduce API calls from N*2 to 1+active
- use normal ThreadSessionRuntime for external sessions
- Update sync-skills.ts
- stabilize e2e timeouts and relax non-deterministic snapshots
- add bot recovery after proxy restart e2e test
- bump e2e timeouts for abort-and-wait settle overhead
- Add external OpenCode session polling sync
- remove prettier
- unify worktree creation into shared createWorktreeInBackground helper
- Add dependency install instructions to anthropic auth plugin
- Update kitty-graphics-agent to ^0.0.5
- Replace kitty-graphics-agent workspace package with npm dependency
- Move usecomputer to standalone repo: github.com/remorses/usecomputer
- Remove zeke folder
- Move SLACK_ADAPTER_DEEP_DIVE.md to slop/
- Remove zoke file
- Remove lintcn folder
- usecomputer 0.1.2: remove all unimplemented TODO command stubs
- usecomputer@0.1.1
- fix Linux build — omit -Dtarget for native host builds
- fix usecomputer CI — pin zeke hash, drop retired macos-13 runner
- use matrix strategy with per-platform runners
- add usecomputer build and publish workflow
- restructure with progressive disclosure
- Update errore submodule: untrack opensrc/ files
- remove unnecessary in operator usage
- suppress notifications for action buttons, question dropdowns, and footer when queue has next item
- add noUncheckedIndexedAccess to npm-package skill tsconfig
- libsqlproxy@0.1.0
- Create SKILL.md
- omit session title on creation so OpenCode auto-generates a summary
- kimaki@0.4.82
- increase IPC stale TTL and runtime idle sweeper to 24 hours
- rename opencode-plugin to kimaki-opencode-plugin
- Migrate no_unhandled_error rule to subfolder layout
- kimaki@0.4.81
- kimaki@0.4.80
- wrap long lines in prompt.md file attachment for Discord readability
- simplify anthropic auth plugin: 1242 → 688 lines
- move anthropic OAuth auth plugin into discord package
- add `session discord-url` CLI command
- add lintcn dependency and lint script to discord package
- improve voice attachment detection and guard against empty prompts after transcription
- add multi-tenant best practices and examples to fly-admin README
- add lintcn package, .lintcn project rules, and lintcn skill
- update npm-package skill: remove typescript pinning rule, add .gitignore section
- set KIMAKI=1 env var when spawning opencode server process
- kimaki@0.4.79
- updates
- remove refs to hono
- Use error.stack instead of error.message in internal logger calls for easier debugging
- tweak /tasks: rename button to Delete, increase prompt truncation to 240 chars
- unified select handler with plugin prompt support
- add /tasks Discord slash command
- Suppress footer notification when queue has pending messages
- Rename Slack bridge WebSocket path from /gateway to /slack/gateway
- Update task-runner.ts
- Bump submodules: errore, gateway-proxy, traforo
- Use timing-safe token comparison in hrana server auth
- Add --permission flag to kimaki send for per-session tool restrictions
- profano changes. --sort
- Improve plugin state management: encapsulate state, extract pure derivation functions, merge onboarding
- Simplify error handler and onboarding status response
- improve /merge-worktree UX: clarify safety in description and error message
- Refactor opencode plugin into focused modules + add working directory tracking for worktrees
- Migrate website from Hono to Spiceflow
- Add spiceflow to synced skills list
- update gateway-proxy submodule: graceful Result for wait_until_ready
- update gateway-proxy submodule: fix missed-notify race in shard Ready primitive
- update gateway-proxy submodule: shard READY gate for client connections
- Revert "perf(discord): skip GUILD_CREATE wait on startup with waitGuildTimeout: 0"
- optimize startup time for scale-to-zero cold starts
- kimaki@0.4.78
- type-safe CLI framework for Zig + usecomputer standalone executable
- Update discord-bot.ts
- kimaki@0.4.77
- switch bridge to direct napigen methods with real-native tests
- Create native-click-smoke.test.ts
- refresh e2e snapshots for agent and queue flows
- Create README.md
- Create interactions.e2e.test.ts
- split node runtime and make gateway URLs origin-driven
- replace Record<string,unknown> with Slack SDK response types
- update queue-advanced snapshots for tool-calls footer exclusion
- add agent switching instructions to system prompt
- add footer dedup tests for multi-step tool chains + fix flaky e2e port collisions
- replace custom Slack types with @slack/web-api SDK imports
- generate schema.sql from prisma instead of hand-writing SQL in applySchema()
- add e2e test for worktree lifecycle — session responds after /new-worktree switches sdkDirectory
- npm-package skill: switch from .js to .ts/.tsx import extensions
- wrap background ensureDefaultChannelsWithWelcome in try/catch
- kimaki@0.4.76
- remove per-channel log spam on startup, print only count
- split typing interrupt test for parallel execution
- rename deploy script to deployment in website/package.json
- replace 3s sleep with polling in question tool test
- support more punctuation in queue suffix pattern
- strengthen question tool test with regression assertion
- Update onboarding-welcome.ts
- add e2e test for user text message answering pending question tool
- kimaki@0.4.75
- more clear critique urls info for dumb agents
- Update onboarding-tutorial.ts
- update gateway vs self-hosted select labels
- improve onboarding tutorial: touch controls, server port, tmux robustness, diff URL, formatted suggestions
- remove hint properties from clack select options and drop experimental label from gateway mode
- sync-skills: only copy SKILL.md, never full skill directories
- npm-package skill: move chmod +x into build script, simplify prepublishOnly
- npm-package skill: add bin field section with chmod +x and shebang instructions
- npm-package skill: make prepublishOnly script explicit with example
- npm-package skill: add sections for runtime version reading, path resolution, and dev detection
- -u
- simplify onboarding flow — extract resolveCredentials, replace isQuickStart
- Update hrana-server.ts
- undo bot status commits for clean recommit
- move branch injection to last synthetic part, lowercase format
- rename commands/worktree.ts to commands/new-worktree.ts
- debounce typing re-pulses
- Update bin.js
- change agent commands wording
- update permission typing snapshot
- share one opencode server across projects
- compress heap snapshots with gzip and disable monitor in production
- kimaki@0.4.74
- replace plugin Discord REST tools with CLI commands
- add e2e tests for thread model isolation on channel agent change
- wait for aborted assistant update before interrupt resume
- kimaki@0.4.73
- better getDiscordRestApiUrl() log
- disable sentry
- back to use hooks after for creating the gateway clients
- simplify user-defined commands log to only show count
- remove request-local guild closure in OAuth callback
- Avoid duplicate context usage notice before the footer
- Gate queue draining behind real run completion
- add todo test for interrupt plugin bug: user message dropped after abort
- Update .gitignore
- usecomputer idea
- rename gateway install endpoint to /discord-install
- migrate gateway onboarding to better-auth state flow
- Group consecutive same-author messages in text() and fix snapshot placement
- use Prisma compilerBuild = "small" for smaller WASM
- reduce website CF Worker bundle from 7100 KiB to 2916 KiB (59%)
- batch CLI flag store.setState calls into single call
- use Prisma enums for BotMode, VerbosityLevel, WorktreeStatus, ChannelType
- remove git diff capture/apply from worktree creation
- move worktree logic into a reusable module
- move message preprocessing from discord-bot into runtime's serialized chain
- add tracked real task-events fixture for subtask derivation
- derive subtask labels from event-indexed task metadata
- rename gateway app id env
- remove channel app-id scoping from channel mappings
- Add gateway onboarding sync delay and update proxy integration
- Use guild-scoped slash command registration in gateway mode and improve auth rejection visibility
- bump discord-digital-twin to 0.1.0
- cover interrupt runtime and remove dead reducer path
- replay real opencode interrupt events
- Revert "fix: harden gateway failure handling and typing diagnostics"
- replace event-stream inline snapshots with explicit assertions
- simplify opencode session jsonl format
- drop unrelated cli/jsonl log refactor from event-order commit
- persist deterministic same-millisecond session event order
- add runtime event snapshot export and compact buffered opencode events
- derive queue dispatch gating from event buffer and expand typing-stop e2e coverage
- stabilize queue-ordering e2e semantics and anchored assertions
- simplify typing lifecycle to event-derived reconcile loop
- make typing start non-blocking in serialized runtime path
- phase 5: remove phase-polling tests and document event-sourcing
- phase 4: remove runController from thread runtime
- Update voice-message.e2e.test.ts
- phase 3: remove mirrored run lifecycle store state
- replace runtime lifecycle decisions with event-stream derivation
- phase 0: add pure event-stream state derivation module + fixture tests
- stop typing indicator before sending footer message
- add apply patch as essential tool
- improve e2e test infrastructure and stabilize suites
- add real cached-provider event capture suite and fixtures
- refresh e2e snapshots after queue and voice stabilization
- stabilize discord e2e infrastructure under parallel runs
- replace onTestFailed log dumps with opt-in KIMAKI_TEST_LOGS env var
- Update event-driven-state-simplification.md
- add deterministic event-stream jsonl fixtures
- cap vitest workers to 4, split queue-advanced tests, await startTyping
- rename [typing] to [bot typing] in text() snapshots
- add inline text() snapshots to all e2e tests
- Add event-driven state simplification plan
- Add e2e test reproducing agent model bug in promptAsync path
- Add event sourcing coverage to zustand-centralized-state skill description
- Suppress footer on interrupted runs using unreplied-user-message heuristic
- Instruct model to always use critique for diff requests
- Suppress spurious footer after abort/interrupt and make interrupt timeout configurable
- Add state encapsulation and event sourcing sections to zustand skill
- Document session-event JSONL debugging workflow with jq examples
- Keep opencode plugin exports explicit and stable
- Refresh queue and abort e2e coverage for promptAsync behavior
- Switch runtime ingress to opencode queue mode and harden part delivery
- Allow OpenCode sessions to read ~/.kimaki without permission prompts
- add interruptOpencodeSessionOnUserMessage support as a plugin. so user messages are not ignored forever
- Simplify thread run lifecycle and abort handling
- Differentiate skill and command slash routing
- Simplify bot credential resolution: remove mode param, use timestamp touch
- Add TODO: consider dropping app_id channel filtering
- Support mode switching between self-hosted and gateway without re-onboarding
- Update gateway-proxy submodule: fix database TLS connection to PlanetScale
- Inline route handlers into index.tsx, extract Discord utils to discord.ts
- Verify OAuth callback with Discord code exchange, store user data
- Update gateway-proxy submodule: rename 'built-in bot mode' to 'gateway bot mode'
- Add Cloudflare Hyperdrive for pooled DB connections (~3x faster)
- Add per-request Prisma client guidance to website AGENTS.md
- Rename '--restart' to '--restart-onboarding' and 'built-in' BotMode to 'gateway'
- Improve built-in onboarding UX: longer timeout, progressive hints, credential warnings
- Update gateway-proxy submodule: add landing page at root
- Type-safe gateway OAuth state + per-request Prisma client factory
- Add --gateway flag to force built-in gateway mode
- Add repo architecture documentation to AGENTS.md
- Set up db package with Prisma client and deploy website to kimaki.xyz
- Sort /login providers by popularity instead of alphabetically
- Document Zustand state fields: why each exists, when it changes, who reads it
- Delay /queue echo until queued item is actually dispatched
- Replace /verbosity string option with select menu dropdown
- Add explanatory comment for atomic queue position snapshot
- Show queue position notification for queued voice messages
- Add OpenCode session assertions to voice message e2e tests
- Add voice message e2e test infrastructure with deterministic transcription
- Strengthen tunnel instructions in system message
- Phase 5: remove legacy globals, dead code, and threadMessageQueue
- pre-warm opencode server in thread-message-queue beforeAll
- make markdown tests deterministic with isolated opencode server
- extract shared e2e test cleanup, add session deletion to all test files
- centralize ThreadSessionRuntime class fields into zustand store
- phase 4 runtime fixes + deterministic e2e hardening
- Phase 4: migrate all command dependencies to ThreadSessionRuntime APIs
- update e2e tests: reduce timeouts, fix assertion for silenced abort errors
- Phase 2+3: implement ThreadSessionRuntime — event listener, dispatch, and ingress routing
- delete session snapshot files — replaced by deterministic inline snapshots
- Phase 1: event listener runtime migration — extend store, add runtime skeleton
- centralize config state into zustand/vanilla store (Phase 1)
- zustand skill: add subscribeWithSelector section for watching nested state
- simplify built-in bot mode: remove dead code, centralize REST routing, JSON OAuth state
- add workerd runtime to Prisma generator for CF Workers compatibility
- deploy website to Cloudflare Workers
- add event-listener runtime migration blueprint with derived-state constraints
- support state and redirect uri in utils discord install url
- move built-in REST proxy path to gateway and add e2e coverage
- add website onboarding and proxy routes with errore flow
- update gateway-proxy submodule: track deployment script
- update gateway-proxy submodule, AGENTS.md opensrc section, and lockfile
- update gateway-proxy submodule: dynamic client config + schema docs
- update submodules: errore (deprecate tryAsync, add SKILL.md guidelines) and gateway-proxy (database-backed client registry)
- simplify voice reply handling by removing queue path
- add configurable Discord REST/WS URL overrides
- add 5 gateway-proxy e2e tests for event routing
- increase queue message preview from 100 to 1000 characters
- add gateway-proxy e2e integration test
- add gateway-proxy submodule on multi-client-support branch
- update traforo: bump goke to ^6.2.0
- kimaki@0.4.72
- add interaction-member permission regression tests
- kimaki@0.4.71
- kimaki@0.4.70
- extract session run transitions into dedicated Zustand state module
- treat mutable resources as centralized state
- fix flaky interrupt e2e tests + add slow tool call abort test
- add resource co-location section to zustand centralized state
- bump discord-api-types to 0.38.40, deduplicate versions
- add e2e tests for thread message queue timing edge cases
- document critique review --web in system message
- replace flat API with scoped channel/thread accessors
- add e2e tests for thread message queue ordering + improve session error display
- improve libsql cache proxy performance: WAL pragmas + remove redundant UPDATE
- use errore.isAbortError in sentry beforeSend for cause-chain aware abort filtering
- replace .abort(new Error()) with typed SessionAbortError
- remove 'only agents listed above are valid' claim
- inject available agents list with descriptions into session system message
- remove --frozen-lockfile from worktree install commands
- Delete SKILL.md
- add centralized-state skill for Zustand-based state management
- update errore submodule pointer
- Update opencode-plugin.ts
- add sentry reporting at terminal error boundaries
- update remote machines plan: thread-per-machine model, hrana already built, OpenCode server auth
- truncate large tool outputs in session read to 30k chars
- add goke CLI framework as synced skill
- condense MEMORY.md into line-numbered TOC via marked AST, update reminder wording
- remove --memory flag and ~/.kimaki/memory/ infrastructure, replace with simple MEMORY.md plugin
- Create startup-service.ts
- kimaki@0.4.69
- increase action button TTL from 30 minutes to 24 hours
- simplify waitForServer to single /api/health endpoint, replace localhost with 127.0.0.1
- remove opncode upgrade command. fix #49
- termcast skill
- skills
- add repo, description, license, author and keywords to discord-digital-twin package.json
- add changelog for discord-digital-twin 0.0.1
- prepare discord-digital-twin for npm publish
- switch DigitalDiscord to action-then-wait API
- add playwright-style DigitalDiscord actor and expect APIs
- switch kimaki e2e to discord-digital-twin
- format docs, plans, and config files with prettier
- format discord package with prettier
- format discord-digital-twin with prettier
- Create sandbox-sdk.md
- teach agents to proactively schedule reminders with --send-at
- store projectChannelId in Discord forum starter messages
- discord-digital-twin Phase 4: interactions (slash commands, webhooks, follow-ups)
- discord-digital-twin Phase 3: channels, threads, and thread members
- discord-digital-twin: add dbUrl option and named in-memory DBs for test isolation
- discord-digital-twin Phase 2: messages, reactions, and libsql cache=shared fix
- Increase archive thread delay from 5s to 10s
- sort /login and /model dropdown options alphabetically by name
- Update digital-discord plan to match Phase 1 implementation
- Add app.log to gitignore
- Add discord-digital-twin package (Phase 1) with type-safe serializers
- Add OpenAI transcription support and /transcription-key command
- Auto-create project tags on memory forum, suppress embeds in forum messages
- Refactor voice transcription to use AI SDK providers (LanguageModelV3)
- restructure gateway example as DiscordGateway class
- Remove unused bot_instances table
- Use direct file: for bot Prisma, Hrana only for plugin processes
- Replace sqld with in-process Hrana v2 server and DB-based IPC
- add threadId to system prompt and thread reminder use case for --send-at
- add self-message guard to prevent loops when bot has Kimaki role
- allow bots with Kimaki role to trigger sessions
- kimaki@0.4.68
- Update system-message.ts
- Update openclaw-tools.md
- Create welcome-channel-plan.md
- format
- split monolithic 1432-line file into focused modules
- make quick-start startup non-blocking
- remove $message usage
- submods
- show tui.toast.show
- update kimaki tunnel guidance and bump traforo
- kimaki@0.4.66
- traforo@0.0.8
- migrate from @opencode-ai/sdk v1 to v2
- run oxfmt formatter across src
- replace deprecated ephemeral: true with MessageFlags.Ephemeral
- parallelize session-handler async operations
- Revert "style(discord): run oxfmt on all src and scripts files"
- kimaki@0.4.64
- session read: search across all projects when session not found in current project
- rely on marked AST for list/code formatting
- silently remove permission buttons on auto-reject instead of sending warning message
- add --no-critique flag to disable auto diff upload to critique.work
- prisma version in package.json MUST be pinned. no ^. this makes sure the generated prisma code is compatible with the prisma client used in the npm package
- abort all active channel sessions before restarting opencode server
- kimaki@0.4.63
- remove ai sdk tool dependency
- use asterisk markdown italic instead of underscore in session completion message
- silently remove buttons instead of showing expired permission message
- kimaki@0.4.62
- show project folder and git branch in session completion message
- unify /model scope selection for threads and channels
- hide session cost line in /context-usage when cost is zero
- Update session-handler.ts
- remove /context-usage token breakdown line
- snapshot model+agent at message arrival to prevent race with /agent changes
- context usage fixes
- speed up /xxx-agent quick commands by skipping opencode server
- Create remote-opencode-servers.md
- kimaki@0.4.60
- reuse thread archive flow in CLI and plugin
- adjust archive-thread delay to 2s
- migrate discord CLI parser from cac to goke
- Create KIMAKI_AGENTS.md
- change merge-worktree dirty handling to explicit error
- switch kimaki worktree creation to native git and improve thread feedback
- Deduplicate redundant permission prompts by pattern coverage
- Revert diamond prefix suppression for consecutive text parts
- Add worktree creation instructions to system message
- Downgrade non-actionable session error logs
- Add --auto-restart respawn wrapper and version command
- Increase previous handler wait timeout from 1000ms to 1500ms
- Add heap snapshot monitor with SIGUSR1 support
- Update AGENTS.md opensrc section and errore submodule
- Skip squash+rebase on retry after resolved conflict
- Refactor merge-worktree to use errore: tagged errors as values
- Rewrite merge-worktree to use worktrunk-style pipeline
- Add system message instruction to always show URLs in search results
- Add ManageEvents permission to bot install URL
- improve detectPm to use script realpath instead of execPath
- update system prompt: prefer h1/h2 headings with numbered steps, heavy ASCII diagrams
- replace SIGUSR2 restart with spawning new kimaki process
- centralize execAsync with default timeout and strip ANSI from shell output
- kimaki@0.4.59
- simplify table keys to bold only, remove code formatting and padding
- use bold inline code for table keys with padded alignment
- rename CLI add-project references to project add
- kimaki@0.4.58
- kimaki@0.4.57
- Strip mentions from thread titles and check mention mode before permissions
- Document cross-project commands in system message and fix project add exit code
- Add project subcommands and make send default to cwd
- Add trailing newline to AGENTS.md
- Change default verbosity to text-and-essential-tools
- Update permission button styles for better UX
- Add emoji reactions for thread marking and worktree identification
- skip logging abort errors in session handler
- enhance diff command with embed preview, add archive thread tool
- add /diff command to show git diff as shareable URL
- resolve Discord mentions to usernames in prompts and thread titles
- Update mention-mode.ts
- Add Claude-style markdown formatting instructions to system prompt
- use YAML instead of JSON for embed marker
- send discord username as synthetic text part for TUI hiding
- remove gemini api key step from onboarding
- kimaki@0.4.55
- migrate back to idempotent schema
- adopt prisma migrations for db setup
- Update db.ts
- run schema.sql at startup to keep existing dbs compatible
- migrate database calls from raw SQL to Prisma functions
- add Prisma schema with type-safe queries and FK relations
- remove spinner, use simple logs
- Guard idle abort until assistant output
- remove bin.js retry logic
- Add Gemini API key prompt for voice
- Update logger.ts
- add sqlitedb CLI command to show database location
- remove --domain flag from kimaki tunnel command
- kimaki@0.4.54 and traforo@0.0.5
- move traforo to standalone repo as submodule
- add baseDomain option, default to traforo.dev
- Update CHANGELOG.md
- kimaki@0.4.53 and traforo@0.0.4
- Update client.ts
- Create jitter-clipboard.json
- nicer offline html response
- add @xmorse/cac to discord package
- switch to @xmorse/cac and npx kimaki tunnel
- jitter skill
- add comprehensive integration tests
- add streaming/SSE support and Bun example server with WS
- prefix with /traforo
- use NodeNext module resolution and compile to dist for traforo
- rename tunnel folder to traforo
- rename kimaki-tunnel to traforo and publish
- add tunnel package for exposing local servers via cloudflare DO
- Show current model info in /model command
- Show task agent in Discord
- Filter bash tools by side effects
- Keep /resume as sole resume command
- Add /resume-session and restrict resume to channels
- Clarify /login as /connect replacement
- replace worktree enable/disable with toggle
- Prefer agent model over channel preference
- add /login command to authenticate with AI providers
- Create restart-opencode-server.ts
- kimaki@0.4.52
- include Discord CDN URLs for image attachments in prompts
- add-project: add suggestion to use CLI for unlisted projects
- prefixWithDiscordUser
- disable voice channels by default, add --enable-voice-channels flag
- update clack to latest
- more abort logs
- refactor createNewProject
- parsePatchCounts
- simplify waitForServer to check single health endpoint
- shorten log prefixes to max 8 chars
- aligned logging with LogPrefix enum and picocolors
- use different clack errors
- kimaki@0.4.45
- add session snapshot transcripts
- refactor to use errore in session handler instead of try catch blocks
- errore submod
- linearize discord session event flow
- move channel config from XML topic to SQLite
- kimaki@0.4.44
- kimaki@0.4.43, errore@0.9.0
- kimaki@0.4.42, errore@0.8.0
- kimaki@0.4.41
- kimaki@0.4.40
- use instanceof Error instead of errore.isError for consistency
- send all images in single Discord message for grid display
- Update errore submodule to 0.7.1
- kimaki@0.4.39
- display subtask events with indexed labels (explore-1, explore-2)
- Update remove-project.ts
- normalize spaces
- Update tools.ts
- Adopt errore typed errors across discord bot
- errore things
- Create .gitmodules
- Use namespace imports in docs for better readability
- Add let+try-catch migration patterns to MIGRATION.md
- Add MIGRATION.md guide for Go-style error handling
- Add _ handler in matchError for plain Error support
- Add composition examples and tests
- Add Error | T | null examples: Result + Option combined naturally
- Add errore package: type-safe errors as values for TypeScript
- exclude hidden agents
- opensrc
- add support for creating channels for folders in new session command
- use first option for placeholder in question tool
- format with oxc
- add agent param in /session command
- Add keep-running instructions to CLI setup outro
- kimaki@0.4.35
- Use opencode from PATH instead of hardcoded path
- Create voice-channel-analysis.md
- kimaki@0.4.34
- send text parts immediately when complete (time.end set)
- don0t type on questions
- tell to use question tool on end
- - fix(cli.ts): sanitize command name by replacing colons with hyphens
- kimaki@0.4.33
- use digit-with-period unicode for todo numbers
- add heading depth limiter for Discord markdown
- kimaki@0.4.32
- kimaki@0.4.31
- context usage empty diamond symbol for parts
- change context usage char
- parallelize CLI startup operations
- kimaki@0.4.30
- kimaki@0.4.29
- improve project list display: abbreviate paths with ~ and filter test projects
- kimaki 0.4.27
- enable notifications for question dropdown messages
- kimaki 0.4.26
- add Discord dropdown support for AI question tool
- less system prompt
- remove text message slash command parsing
- use bot username in category names for multi-bot support
- add /agent command to set agent preference per channel or session
- include image file paths in prompt text
- download image attachments to tmp/ and include paths in prompt
- update discord message icons and formatting
- inline command dispatcher into interaction-handler
- extract commands into separate files with switch dispatcher
- add comments on files
- readme thing
- rename discordBot.ts to discord-bot.ts, delete refactor plan
- extract voice state and interaction handlers (discordBot.ts 1652 -> 496 lines)
- split discordBot.ts into focused modules (3327 -> 1652 lines)
- refactor discord bot into modules, add /fork command
- improve transcription prompts to ensure transcriptionResult tool is always called
- add SILENT_MESSAGE_FLAGS constant combining SuppressEmbeds and SuppressNotifications
- packages
- new audio with grep, etc
- put audio channels in separate thing
- reject permission on new message
- add prev session in transcribe
- do not show already added sessions in resume
- add glob package
- Revert "add critique command docs to KIMAKI_AGENTS.md"
- Add MIT license
- release kimaki@0.4.22
- remove liveapi package (moved to separate repo)
- add Manage Server permission and Kimaki role support
- nicer looking tool calls
- add /add-new-project and /share commands, single instance lock, tool running status
- throw errors if prompt fails
- add support for file attachments. fix restart signal
- update to gemini-2.5-flash-native-audio model for better live audio
- update ai-sdk, @google/genai, and zod to latest versions
- remove send to discord command
- mention long files as uploadable in system prompt
- remove misleading error message in upload-to-discord
- move upload-to-discord info to system prompt
- add upload-to-discord command and refactor plugin to CLI-based commands
- bash tool shows command in inline code when short
- code blocks for tables and diagrams MUST have Max length of 85 characters. otherwise the content will wrap
- adding OPENCODE_SYSTEM_MESSAGE
- discord message splitting preserves code block formatting
- show toast at start when creating Discord thread
- improve error handling in OpenCode plugin
- add support for sending current session to discord
- release
- add support for images
- update discord sdk
- add used model info
- Revert "Batch assistant parts in resume command to avoid Discord rate limits"
- more fixes for rest api
- nicer end comment
- add-project command. also remove backticks inside code snippets. better summaries for tools
- Create escape-backticks.test.ts
- refactor formatPart
- revert abort controller separation, bump to 0.4.2
- Revert "fix event stream being aborted when new messages arrive during long commands"
- hide the too many tool calls texts
- support DOMException from undici in isAbortError, bump to 0.3.2
- display custom tool calls in Discord with colon-delimited key-value fields, add webfetch URL formatting, bump to 0.3.1
- change
- better isAbortError
- pass OPENCODE_CONFIG_CONTENT
- disable undici timeout
- undici
- add isAbortError
- add script
- delete unused folders
- pass custom fetch
- simpler onboarding. do not ask for server id
- Update pcm-to-mp3.ts
- use nicer cross unicode
- - Check for OpenCode CLI availability at startup and offer to install it if missing - Automatically install OpenCode using the official install script when user confirms - Set OPENCODE_PATH environment variable for the current session after installation - Use the discovered OpenCode path for all subsequent spawn commands
- put database in homedir
- use gemini to transcribe too
- add api keys inputs in the onboarding
- cleaner logs
- show the channel select when bot has no channels
- bot asks to confirm intents required
- move saving of discord bot token after using it
- remove xml from user messages
- nicer handling of opencode server errors
- Update discordBot.ts
- use clack for logs. adding session command
- nicer looking todos
- hide think bubbles
- abort prompt request on new messages
- only send completed messages on finish
- add ensureKimakiCategory
- better cli
- adding bin.sh
- adding files inside
- rm stuff
- add more error handlers for voice
- add error handlers for opus
- use my own personal resampler
- Update genai-worker.ts
- send audioStreamEnd
- write audio files on exit
- using worker for audio
- debug audio. nicer code foramtting too
- trued openai realtime. same shit
- use better model. ask to greet
- better system prompt for voice channels
- better sigint
- notify the agent on sessino ends
- only call interrupt on interrupt
- add tools for voice bot
- rename files
- adding tools in discord
- Update directVoiceStreaming.ts
- add interrupt
- add my own streamer. it fucking owrks. if i send every 20ms
- works with node???
- use working sqlite
- more debugging
- do not rely on bun
- register only once
- try using opus.Encoder
- works.
- voice channels work
- testing
- genai works
- added genai
- added voice channels handling
- Simplify Discord escaping to use single function
- Refactor Discord escaping into reusable functions
- Add escaping for double pipe characters in Discord output
- Improve Discord formatting escaping for tool outputs
- Improve tool call formatting in Discord bot
- do not always show channels list
- cli works
- only handle channels for this app id
- create channels in the cli
- adding cli
- send basenames in voice prompt
- update voice thread names
- handle voice channels
- show typing even after sending messages
- stop typing on abort
- better todo write. better typing events
- add voice
- use reactions
- no layout shifts
- abort requests if there is a reply. split at markdown chunks
- handle long messages
- abort events after finish
- support many channels
- add getOpencodeProjects
- adding more functions
- nicer output
- nicer rendering of tools
- added test events script
- opencode is shit
- events are not sent
- cleanup types.
- remove some files. refactor
- edit last message instead
- kind of works
- convert to opencode
- add initial discord bot
- reneames
- Update config.json
- Delete todo-tool.ts
- revert change
- adding build
- realtime works
- adding reatime
- colors
- add ascii video animation
- claude fixed issues. i hope
- use ansi brightness for ascii
- add ascii things. tried using bun. fails. added Ink for nicer tui
- Ensure consistent per-session model by reusing the last assistant model on submit; prevent model drift by not accepting model/provider in the submit tool.
- adding models select
- add session resumption
- use much better model. add abort chat tool
- stabilize messaging flow by removing messageId coupling and adding startup delay to improve spiceflow handshake
- DEBUG
- apply prettier formatting to all files
- save audio files for user to debug
- use xml
- send when a message is completed
- nicer prompt
- remove useless try catches
- snapshots
- markdown thing
- markdown works
- plugin works
- adding liveapi
- ini

### Fixed
- reject cut-off and blocked provider responses
- retry transient transcription failures, drop AI SDK for fetch
- retry db initialization after a failed attempt
- Fix tsc error in session read last-assistant filter
- Fix bot stuck on hrana lock port after a stop signal during startup
- Fix Anthropic OAuth fetch crashing when auth.json lost its anthropic entry
- Fix OpenAI voice transcription Invalid JSON response.
- Fix cleanup after Discord channel deletion
- Fix upload-to-discord posting into the parent /btw thread.
- Fix persisted /queue FIFO order and delivery.
- sanitize callout thread titles
- Fix Discord reply handling across compaction
- keep sessions running when threads are archived
- Fix single-line Discord callout rendering
- Fix worktrees selecting duplicate remote clones
- Fix Discord sleep wake nonce length
- do not transcribe video attachments as voice messages
- restart Kimaki after Discord connect timeouts
- remove AskUserQuestion timeout instead of making it configurable
- resolve a session to its most recently bound Discord thread
- post Discord task lines on running, not completed
- keep Discord IDs separate from usernames
- show OpenAI task parts in Discord
- build long prompt attachments in memory for parallel send
- Fix two more table/callout text-limit edge cases found by oracle review
- Fix Discord sendMessage failure for long tables
- directory allow rules must not override user config
- harden /api/transcribe against memory blowup and quota bypass
- allow /create-new-project to run from inside a thread
- fix flaky first-turn waits in e2e tests
- fix inference-proxy memoize cache never storing anything
- inject kimaki system prompt into OpenCode commands
- retry first voice note after API key setup
- fix legal document imports
- fix event delivery across OpenCode restarts
- fix worktree session tool directory
- fix redundant "kimaki -- kimaki" browser tab title, update holocron to 0.25.1
- CLI subcommands reuse bot OpenCode server via hrana discovery
- skip embed-only MESSAGE_UPDATE events to prevent false queue removals
- persist workspace association for /new-session in threads
- use worktree directory for /btw, . btw suffix, and user commands in worktree threads
- update worktree lifecycle test snapshot for deterministic suffix
- include text attachments and file images in preprocessNewSessionMessage
- guard CLI-side worktree prefix with isGitRepositoryRoot check, add test snapshot
- auto-create worktrees for kimaki send --channel when channel toggle is enabled
- replace rimraf with rm -rf in opencode-kimaki-plugin prepublish
- let setup commands run from any channel in multi-machine mode
- pin frozen dependency bootstrap
- use os.tmpdir() for prompt attachment temp files in kimaki send
- treat Discord TLS cert failures as restartable
- keep parent system block opt-in for btw/task forks
- remove queued messages when Discord messages are deleted
- fix stale comment about selfRestart wrapper behavior
- remove fragile detached spawn fallback in selfRestart
- add worktree support to user-defined slash commands (-cmd, -skill, -mcp-prompt)
- always show ellipsis when bash command is truncated to first line
- project guild resolution in gateway mode + show custom tools in default verbosity
- skip leading blank lines in bash tool title truncation
- handle missing bash tool description field by truncating command first line
- agent slash commands with prompts now create worktrees when worktree mode is enabled
- guard --wait and --send-at before sending in existing thread mode
- make kimaki send work in CI without local database state
- fix workspace worktree cleanup
- Fix oracle review findings in inference-proxy
- reply with guidance when setup commands run in non-project channels
- route setup commands to the machine active in the guild
- guard all inbound Discord events with channel ownership check
- route interactions only to the machine that owns the channel
- fix question dropdown completion
- open gateway install URL on Windows
- add missing colors field to APIRole mock
- fix /worktrees exceeding Discord 4000-char displayable text limit
- gateway onboarding timeout — guild_id fallback, error visibility, consent prompt
- fix truncation to use separator-delimited row groups, fix deferReply vs deferUpdate detection
- fix truncateComponents to truncate Container children instead of dropping entire Containers
- fix /worktrees and /last-sessions exceeding Discord 40-component limit, fix silent interaction errors
- stop adopting default kimaki channel from another instance in shared guilds
- improve btw fork prompt and use correct channelId
- preserve model across forked sessions
- clear worktree marker when merge has no commits
- skip thread creation for notify-only on non-project channels
- prefer wrapper restart in selfRestart for Ctrl+C support
- guard selfRestart against concurrent calls
- self-restart on gateway reconnect limit instead of process.exit(1)
- allow --agent and --model with --thread/--session in kimaki send
- use stdout for machine-readable output, warn on catch, drop directory from abort
- use sdkDirectory (session/worktree dir) for all OpenCode client lookups
- dismiss stale permission buttons when plugin auto-rejects
- remove followup prompt after subagent abort, add TODO
- wait 200ms before sending followup prompt after subagent abort
- remove notifyError for expected subagent abort failures
- auto-reject subagent permission prompts
- stabilize flaky queue edit-remove test
- move permission auto-reject before getEventSessionId early return
- use correct event type for subagent permission auto-reject
- wrap .catch() callbacks in tagged domain errors
- convert errore.try object-form to positional args
- use namespace imports in ipc-polling.ts and markdown.ts
- use namespace import in errors.ts instead of destructured imports
- guard permission timeout against setTimeout overflow
- prevent stale interrupt timers from aborting unrelated generations
- restore queue hint text and update snapshots
- remove duplicate changeset file, update existing one
- pass OpenCode server auth credentials to SDK client
- /model and /model-variant global/channel scope now updates current session
- fix all broken docs links: convert absolute /docs/ paths to relative
- keep completion history when a later message update lacks completed
- point model-switching tip at the new docs path
- fork new worktree sessions into separate threads
- keep worktree threads on the same session
- start fresh sessions after worktree switches
- use current OpenAI audio transcription model
- strip --env-file flags from the relocatable kimaki shim
- adapt to opencode SDK 1.15.11 event ids and error shapes
- build own v2 client from serverUrl instead of broken ctx.client
- fix btw suffix to be end-of-message marker like queue
- use resolveMentions in MessageUpdate handler to preserve newlines
- Fix interrupt replay after abort idle ordering
- fix model-switching docs URL: kimaki.dev/model-switching not /docs/model-switching
- fix sync timeout: use AbortController with proper cancellation
- fix kimaki opencode passthrough: allow unknown options and handle Windows shims
- safe sorting and trim-before-fallback in model select options
- sanitize model/provider select options for undefined names
- fix inline quick-agent prompt sessions
- fix Discord ingress permission checks
- clear stale global Discord commands
- truncate opencode session errors in Discord
- fix event stream listener reconnect loop on normal stream completion
- fix musl detection ESM bug and rename race condition
- fix opencode download: musl/baseline fallback, race-safe temp dir, anchored cleanup
- handle opencode global event stream
- Fix OpenCode startup healthcheck hangs
- Fix Hrana SQLite schema bootstrap
- Fix non-git worktree session fallback
- Fix main CI snapshot failures
- Fix merge-worktree dirty target failures
- Fix Anthropic prompt instruction stripping
- Fix voice agent selection to not trigger on casual use of agent name words
- Fix Bun crash in evictExistingInstance when .json() returns null
- Fix Bun dev startup isolation
- pass resolved model to opencode commands
- handle subagent prompts in anthropic system text sanitization
- update cwd extraction regex in anthropic plugin for new opencode system prompt format
- fix callout rendering: skip ⬥ prefix for <callout> tags
- fix fork-subagent replay formatting
- extract per-session cwd from stripped OpenCode identity block
- fix website dev restart loop from doppler mount
- Fix CI-only permission and plugin loading tests
- Fix vitest OpenCode startup paths
- fix interrupt plugin infinite abort→replay loop on large contexts
- fix homedir bug
- fix anthropic again. very picky
- fix opencode directory resolution and speed up e2e failures
- fix opencode log chunking for readable output
- fix system prompt drift toast diff display
- fix queued question handoff and update goke
- dedupe task start messages
- fix anthropic again? I am such a genius
- fix ~/.config/opencode/skills/<skill-name>/SKILL.md
- re-inject process cwd into Anthropic sanitized system prompt
- use MUST wording and cite overriding other changes in worktree/cwd reminders
- drop confusing 'worktree reminders emitted only on change' note
- mention pwd change and forbid writes to previous folder in worktree/cwd reminders
- append trailing newline to synthetic user message parts
- fix queue drain after dropdown answers
- load the built OpenCode plugin from dist in published kimaki
- fix anthropic third party app detection
- fix max subscription by removing OpenCode identity section instead of replacing full prompt
- use namespace import for discord.js CJS interop in plugin chain
- Fix Anthropic Max Subscription third party detection. Max subscription works again
- route /command-cmd prompts via session.command when registeredUserCommands is empty
- fix external sync session discovery
- replay interrupted queued prompts instead of resuming empty sessions
- remove final clack import from plugin startup path
- isolate opencode plugin logging from clack
- drop opencode server log prefixes
- always log opencode server warnings
- skip restart wrapper only for --help
- keep stable --user examples in Kimaki send prompts
- fix lockfile
- keep stable channel context in the session prompt
- keep Kimaki system prompt stable across a session
- avoid duplicating markdown task list markers after marked upgrade
- fix anthropic plugin lockfile import for plugin startup
- fix plugin logger compatibility on Node 22
- fix main CI queue recovery and plugin loading
- scope /worktrees to the current project
- Fix pending question handling for voice follow-ups
- stop typing indicator immediately after final part flush at session end
- move injection guard config dir from tmpdir to dataDir
- stop overriding user's external_directory permission defaults
- Fix abort test: replace exact snapshot with ordering invariants
- Fix select-drain snapshot: use contains assertions
- Fix remaining CI test failures
- Fix CI: init git repos in test project directories
- Fix CI: also build libsqlproxy before tests
- Fix CI: pass --run flag through to vitest via pnpm test -- --run
- Fix CI: build submodules (errore, traforo, opencode-injection-guard) before tests
- correct worktree directory switch reminders
- include dynamic command args in new session threads
- correct changelog — injection guard is opt-in, not auto-enabled
- add sessionID to message.updated test fixtures for SDK 1.3.7 compatibility
- skip GuildText startThread for kimaki send starter messages
- use OPENCODE_CONFIG file instead of OPENCODE_CONFIG_CONTENT env var
- cap slash commands at 100 and reorder dynamic commands by priority
- graceful INVALID_SESSION delivery + catch ClientReady errors
- detect discord-user tag in command messages
- always persist direct mappings with || '' fallback
- detect Discord origin when message-id is missing
- remove proxy restart test that killed mid-suite, tighten timeouts
- detect kimaki-owned sessions from events, not DB
- restore production Durable Object migration history
- declare raw markdown imports for preview deploy
- stop logging already-managed session skips
- resume scheduled thread prompts via start marker
- claim forked and resumed sessions earlier
- batch messages, filter subagents, skip placeholders, reduce log noise
- skip sessions created before CLI started
- add debug logging, fix race and silent error swallowing
- fix concurrent message ordering and natural completion detection
- add abortActiveRunAndWait to settle abort before next message
- pass workingDirectory to SDK calls, wait for idle before revert
- defer interaction reply before async work
- remove deprecated ephemeral option from deferReply
- normalize gateway_clients secrets across guild rows on upsert
- add shard recovery timeout with forced relogin
- abort busy session before undo/redo revert
- link libc for standalone exe on Linux native builds
- fix readme examples
- harden pipeline validation, condition propagation, and stream lifecycle
- prevent opencode server auto-restart on SIGINT and bot shutdown
- drop session.diff buffering and recursively prune oversized event strings
- Fix Anthropic OAuth transport inside opencode auth
- /model provider pagination filters to connected providers only and preserves header text
- fix OOM: strip parts/system/summary/tools from all message.updated events in event buffer
- fix 3 regressions in anthropic auth plugin simplification
- add error checks on session.get and session.messages SDK responses
- step-by-step forward walk matching OpenCode TUI behavior
- use any to bypass zod version skew between opencode-plugin and goke
- add truncateCommandDescription guard to all slash command descriptions
- shorten merge-worktree description to fit Discord's 100-char limit
- use UTC for cron scheduling instead of machine local timezone
- consistent error parsing and context cleanup on failure
- complete code-mode OAuth, improve error parsing, add basic auth
- fix /tasks: cap rows to 10, sanitize table cells, remove unused guildId
- drain queued messages immediately when session is idle, even with pending interactive UI
- Fix --permission gaps: scheduled sends, thread sends, parser hardening, tests
- Fix getInternetReachableBaseUrl doc comment: clarify /kimaki/wake endpoint
- Fix tutorial injection regression: run before non-synthetic text guard
- Fix /undo to match OpenCode TUI approach: pass user message ID, don't delete messages
- Fix Spiceflow migration behavior regressions
- fix local queue draining while session is busy (delta event buffer overflow)
- fix queue suffix detection broken by text attachments
- skip redundant login() that caused spurious gateway reconnect
- enable notifications for error replies
- ignore non-kimaki threads in project channels
- prefix part IDs with prt_ to satisfy OpenCode validation
- close tunnel client on connect failure + poll x11vnc port readiness
- complete OpenAPI 3.0 parity for endpoints and schemas
- sync all types with OpenAPI 3.0 spec
- simplify Linux screenshot desktopIndex cast
- resume thread turns after dismissed permission prompts
- allow opencode tool-output directory by default
- keep critique examples on bunx
- expose kimaki as a direct command in opencode sessions
- restore Windows opencode startup
- route OpenAI audio conversions by normalized media type
- fail closed on callback team authorization
- harden interactive payload handling and scope diagnostics
- map edge REST errors and lock parity tests
- clean up echo-bot script, fix self-echo loop
- reversible thread IDs eliminate cross-channel collisions
- close interrupt resume model fallback
- preserve selected model on interrupt resume
- use SDK types for resolveThreadTsForReaction
- harden interaction routing and Slack contract handling
- autocomplete handlers return empty results with gateway-proxy
- reconnect event listener and reset session when sdkDirectory changes after worktree creation
- preserve content-encoding header, rename deploy→deployment
- namespace custom gateway callback state field
- create default channel and welcome message in non-TTY headless mode
- use mutable Response for gateway callback redirect
- gateway callback URL redirect was silently ignored
- stabilize flaky 'slow stream' test with deterministic timing
- delete question context before abort to prevent race
- question tool stale timeout no longer fakes 'Other' selection
- user text message during pending question no longer sent as duplicate prompt
- fix mkdir for tutorial
- share tutorial trigger and harden channel lookup
- return [inaudible audio] for very short or incomprehensible audio
- anchor footers to assistant completion
- drain local queue on session idle to prevent stuck queued voice transcriptions
- first-message-only tutorial check, return textChannel, cleanup
- harden default channel idempotency with 3-layer detection
- use topic marker for default channel idempotency, graceful git init
- drain local queue after session error
- force-remove worktrees with submodules, use white delete button
- comprehensive runtime and pending-UI cleanup to prevent memory leaks
- prevent agents from running `kimaki` root command inside OpenCode sessions
- replace Section accessories with ActionRow for button cells
- add login timeout, text validation, and shared helper for bot status commands
- show git stderr on delete failure, use ephemeral followUp instead of replacing table
- validate gateway callback URL scheme to prevent open redirect
- pre-allow common directories in server-level external_directory permissions
- mark /worktrees replies as CV2 messages
- reduce voice transcription prefix spacing to single newline
- reconnect runtimes after shared server restart
- correct /worktrees error handling and timeout lifecycle
- add timeouts and caching to /worktrees command
- delay footer send to avoid spurious footer after interruption (disabled)
- skip augmentation for empty plugin messages
- delay footer send by 400ms to avoid spurious footer after interruption
- use -mcp-prompt suffix for MCP-sourced commands instead of -cmd
- keep typing visible during active runs
- skip conflict check when main repo is on a different branch
- only log 'submodules initialized' when init actually succeeded
- guard against passing both threadId and --session to session archive
- make submodule init error in createWorktreeWithSubmodules non-fatal
- make submodule init and validation non-fatal
- resolveBotCredentials prefers DB over env var for gateway mode
- use last_used_at timestamp for cross-process bot mode resolution
- ignore empty resume messages in interrupt plugin
- cap /worktrees output to latest 10 entries
- interrupt queued follow-ups on blocking step finish
- preserve oauth state cookies on discord-install redirect
- remove flaky inline snapshot from concurrent messages test
- update gateway-proxy submodule — add MESSAGE_CONTENT intent
- gateway-proxy reconnection after deploy + e2e test + reconnect logging
- bypass auth for tokenized interaction/webhook routes
- handle deleted worktree folders gracefully in /worktrees
- clean up stale action buttons and cover button continuation
- await enqueue in preprocessChain to prevent session-creation races
- preserve quick-agent names with description metadata
- skip tool display for old assistant messages not in current run window
- guard interactive prompts in non-tty startup
- force channel setup when no channels are configured
- fixes to the discord package.json
- publish discord-digital-twin from dist output
- derive interactive UI gating and snapshot user interactions
- serialize typing pulses to avoid REST queue buildup
- simplify queued-message interrupt plugin
- log gateway lifecycle events for Discord diagnosis
- harden gateway failure handling and typing diagnostics
- enable DAVE encryption for voice connections
- use signal check instead of magic retry count for SIGTERM handling
- eliminate zombie opencode processes after e2e tests
- stabilize 'slow tool call abort' e2e test with explicit waits
- remove trailing newlines from assistant messages, add [typing] markers to text()
- stabilize text() ordering and escape embed titles
- harden run footer and stale-event handling
- simplify promptAsync queue path state handling
- align promptAsync queue path with dispatch behavior
- Fix e2e tests to assert on Discord messages instead of internal logs
- Fix runtime assistant-part routing and restore footer metadata in promptAsync flow
- fix interrupt plugin: use sequence-based event ordering and error barrier before idle wait
- Fix FK constraint: upsert discord_users before gateway_clients, return error details
- Fix stale runtime footer calculations after interrupt races
- Fix typing indicator not stopped after /abort
- Fix interrupt messages showing » queue indicator
- Fix interrupt abort race by settling aborts before redispatch
- Fix overlapping lock port ranges across e2e test files
- Fix 6 oracle review issues from Phase 5, split e2e tests, reduce test delays
- fix voice reply queue latency while preserving queue intent
- fix discord-digital-twin serialization for twilight compatibility
- sync verbosity dropdown default annotation with actual default
- accept /gateway/ path for twilight-gateway compatibility
- race-safe arrival snapshot, audio failure guards, remove premature label
- snapshot active request state at voice message arrival for reliable queueing
- defer thread interrupt for voice messages until after transcription
- remove premature '(queued)' label from transcription message
- opencode plugin was silently failing to load
- restore non-sensitive identifiers stripped by sanitization commit
- sanitize logs and Sentry payloads safely
- attach kimaki version metadata to every error
- make pending worktree writes atomic
- handle interaction member permission shape
- prevent stale idle from ending interrupted follow-up prompts
- add @discordjs/opus to pnpm onlyBuiltDependencies
- suppress clack terminal output during vitest runs
- preserve original command names through Discord sanitization and prevent suffix truncation
- proxy URL forwarding drops base path prefix + add streamChunkDelayMs
- handle slashes and colons in Discord slash command name sanitization
- serialize thread messages to prevent voice transcription race condition
- disable broken ni dependency install in worktree creation
- wrap session context in XML and prevent reusing past transcriptions
- preserve voice message transcription order
- prevent transcription model from answering user questions
- filter synthetic parts from fork dropdown, abort-retry, and session search
- prevent agent from triggering permission prompts on memory and config paths
- OpenAI voice transcription — use gpt-4o-audio-preview chat model + OGG-to-WAV conversion
- derive App ID from bot token, skip interactive prompt when KIMAKI_BOT_TOKEN is set
- markdown test error handling + update stale snapshots
- auto-isolate tests from real ~/.kimaki/ database
- interaction callback preserves messageId, handles UpdateMessage correctly
- ensure project channel footer survives 2000-char limit and empty body fallback
- Fix hrana-server and IPC polling issues from oracle review
- never use --worktree unless user explicitly asks
- snapshot thread agent/model preferences
- ensure parent thread_sessions row exists before creating worktree
- parallelize footer async calls to fix archive-thread race
- resolve deferred session idle race in interactive flows
- require UTC date format for send-at scheduling
- harden memory forum sync startup and file processing
- preserve channelId across server restarts, fix forum-sync subfolder handling
- read file attachments in bot-initiated threads
- prevent duplicate part output on interrupted runs
- prevent interactive UI flush from echoing user messages
- fix resume stuck on 'Loading N messages...' forever
- include opencode stderr tail in startup timeout errors
- render action buttons after stream flush and hide tool call output
- show context percentage first in /context-usage
- harden opencode plugin hooks and upload timeout handling
- label voice transcription prompts for model context
- suppress /model tip link embeds in confirmation replies
- enforce read-only explore permissions in injected opencode config
- prevent typing indicator from restarting after session cleanup
- increase archive delay from 3s to 5s
- truncate unbounded message content to prevent Discord API errors
- guard against non-hydrated guild members in permission check
- fix parallelization bugs in session-handler
- remove decimal digits from session duration in footer
- keep /fork select menu customId under 100 chars
- prevent list/code markdown gluing
- log prisma init stack traces
- avoid echoing command args in channel
- print stack traces for unhandled errors
- show context percentage for large tool outputs
- fail fast on invalid session agent
- harden schema migration SQL parsing
- keep only error reaction on thread messages
- add resolveWorkingDirectory util to fix worktree cwd in slash commands
- avoid repeating diamond prefix on same-message text parts
- use worktree directory for /run-shell-command in worktree threads
- allow ! shell commands to bypass mention mode in text channels
- pass parent channelId to reactToThread in worktree command
- pass parent channelId to reactToThread calls
- react to thread starter message in parent channel
- remove double newlines from permission request messages
- update stale @opencode-ai/sdk override to ^1.1.51
- move @opencode-ai/plugin to dependencies and add version check
- fix permission buttons not being handled
- fix closing thread with set timeout
- trim text parts before rendering
- force function calling mode for transcription
- scope permission auto-reject to instance
- remove broken submodule stubs before initialization
- route permission replies to correct directory
- normalize command names to lowercase for Discord slash commands
- include channel topic in system prompt
- preserve list/code fence separation in Discord output
- disable DM for all slash commands and fetch guilds if cache empty
- fix behavioral changes from SQL to Prisma migration
- fix console logs
- Windows support for OpenCode binary detection and server spawn
- make CLI executable after build
- improve Node.js package setup
- support binary WebSocket messages and non-JSON text frames
- normalize tmpdir path for Windows compatibility
- fix serverUrl undefined issue and add example-static
- check config.model before recent models for default model selection
- don't embed base64 image URLs in prompt text, add HEIC support
- send images as base64 data URLs with resizing support
- strip bracketed paste escape sequences from CLI input
- gate session idle completion
- show apply_patch file names from input
- filter hidden agents from new-session autocomplete
- log ignored errors and gate idle abort
- handle permission requests from subtask sessions
- use ⋅ separator for subtasks and fix double spaces in tool output
- ignore stale session.idle events before content received
- handle apply_patch tool summaries defensively
- pass Error to .abort() to prevent string reason leaking as error
- add defensive handling for apply_patch tool fields
- normalize whitespace in tool call arguments for Discord display
- send user message as question tool answer instead of 'cancelled'
- remove extra blank lines from command response messages
- hide subtask output in text-only verbosity mode
- add users to threads so they appear in sidebar
- serialize discord event handlers
- send queued messages after session completion
- add-project --guild flag now works with large Discord IDs
- dedupe permission dropdowns
- prevent discord markdown chunks exceeding limit
- use embed marker for auto-start instead of database
- use update-ref instead of fetch
- handle non-fast-forward by merging into worktree first
- track multiple pending permissions per thread to prevent duplicates and hangs
- check if worktree exists before creating thread
- edit starter message when worktree is ready instead of sending new message
- increase connection pool to prevent SSE deadlock
- fix 0% token usage race condition by fetching from API
- Fix errore submodule setup
- Fix matchError examples to use return values
- avoid duplicate kimaki in category names
- make database optional in send command for CI environments
- limit discord command name to 32 characters
- fix error display showing unhelpful [string] type, fix unnest trailing whitespace
- fix numbered list code block unnesting to avoid repeating numbers
- prevent infinite loop in splitLongLine with small maxLength
- cancel pending question when user sends new message
- reply with helpful message when user lacks Kimaki role
- flush pending text before showing question dropdowns
- move Kimaki role to bottom position for easier assignment
- use v2 permission API for Accept Always to persist
- fix usage of -cmd commands
- send transcription errors to thread instead of channel
- improve opencode server startup reliability
- handle lines longer than Discord limit in markdown splitting
- escape inline markdown in dynamic content for Discord
- prevent killing own process when checking for existing instance
- register interaction handlers when client is already ready
- fix race conditions and improve session handling performance
- fix context usage percentage
- fix resuem command
- fix event stream being aborted when new messages arrive during long commands
- fix abort controller to pass Error objects instead of strings
- fix isAbortError
- fix entrypoint
- fix get client thing
- FIXED THE BUG BRUHHHHHH
- fix
- use session ID instead of directory for abort controller mapping
- fix thinking remainging there
- fix double text mesages
- fix debouncing
- fixes
- Fix typo in README for GEMINI_API_KEY
- fix isModelSpeaking
- fix cracking user input
- fix sessions sorting

## 0.31.0

1. **Queue a side question until the current turn ends.** In a session thread, end a message with `btw queue`, or use `/queue` with a `btw` prompt, or end a `/btw` prompt with `. queue`. Kimaki waits for earlier queued prompts, then forks the **updated** session into a new thread. The side question never starts a turn in the source thread:

   ```
   Explain the error. btw queue
   ```

   Queued side questions support the normal queue controls: edit or delete the Discord message before it starts. A side question sent from a `btw:` thread can also queue another fork.

2. **Forks reuse the source session's prompt cache.** `. btw`, `/btw` and `/fork` forks used to rebuild the system prompt with new IDs and run the default agent, so the provider processed the whole copied history again. On a 150k-token session the first reply took about 11 seconds and paid a full cache write. Now:

   - The system prompt is **pinned per session**. Data that changes later (for example a `--parent-session` added after the first turn) goes into the per-turn context at the end of the user message.
   - Same-directory forks (`/btw`, `/fork`) reuse the pinned system prompt of their source. `/new-worktree` forks run in another directory, so they cannot share the cache.
   - A fork keeps the **agent** of its fork point, not only the model and variant.
   - Cache misses are visible in `btw` threads: the first reply compares its cache reads with the copied history. Cache-miss notices also show how many minutes passed since the previous assistant message, to separate an expired cache from a changed prompt.

   Changes to channel topic, agent list, or Kimaki prompt text now apply to new sessions only.

3. **`. btw` answers at once.** Kimaki replies right away while it forks the session, then edits the same message with the thread link or the error:

   ```
   -# Forking session to answer this side question...
   ```

   The fork and the Discord thread are created at the same time and setup steps run in parallel. Discord REST rate limits and per-step `[BTW TIMING]` lines are logged to `kimaki.log`.

4. **Estimated input mix in `/context-usage`.** A new line shows the share of visible system instructions, tool calls and results per tool, and other context:

   ```
   Estimated input mix: tool read 42.0% (21) · system 20.0% (10) · other 38.0% (19) tokens
   ```

   Percentages use the latest reported input including cached input. It is an estimate: OpenCode does not expose exact per-part token counts.

5. **`queue` and `btw` suffixes work on every `kimaki send` path.** `kimaki send --channel` and messages with embeds, polls or forwards used to send the literal `queue` word to the model. Long prompts uploaded as `prompt.md` now keep the suffix working too. `/new-session` accepts the suffix, and `/queue` strips it. A `. btw` fork now gets the message's text and image attachments and adds the `--user` from `kimaki send` to the fork thread.

   ```bash
   kimaki send --thread 123456789 --prompt 'Run the tests again. queue'          # wait for current turn
   kimaki send --thread 123456789 --prompt 'What does this error mean? btw'       # fork now
   kimaki send --thread 123456789 --prompt 'Summarize what you changed. btw queue' # fork after the run
   ```

   `kimaki send --help` and the agent system prompt document the suffixes, so agents append `. queue` instead of interrupting a busy thread. Editing a queued message now also keeps its text attachments.

6. **Queued prompts start with a silent reply** instead of reposting the whole prompt. Kimaki replies to the message that queued it (your message, or the `/queue` confirmation) with no ping:

   ```
   -# Executing queued prompt
   ```

7. **Shorter agent instructions.** Duplicated rules and repeated examples are removed. A typical thread session prompt drops from about 10.7k to 8.7k tokens, and every command form, flag, and safety rule stays. The archive and thread-reminder commands are now directly copyable. Agents are told to show found sessions as clickable Discord thread links. Existing sessions keep their pinned prompt; start a new session to use it.

8. **Proactivity rules removed from the system prompt.** Agents are no longer told "Be proactive... Do NOT stop to ask for confirmation". Your own `AGENTS.md` or opencode instructions now decide how eager the agent is, which makes it easier to get root cause analysis before a fix. The `question` tool rules stay. Fixes [#230](https://github.com/remorses/kimaki/issues/230).

9. **More reliable voice transcription.** Kimaki retries up to 3 times on transient Gemini or OpenAI failures: responses with no candidates or a bad finish reason like `MALFORMED_FUNCTION_CALL`, cut-off responses, network errors, and HTTP 408, 409, 429 and 5xx. Invalid API keys and content filter blocks fail at once. Errors now show the HTTP status, the block or finish reason, and the start of the body. Transcription and `kimaki tts` call the REST APIs with `fetch`, so the `@ai-sdk/*` dependencies are removed. Gemini TTS audio gets the correct WAV header for `audio/L16;codec=pcm;rate=24000`.

10. **Lighter install.** Anonymous analytics use the zero-dependency `@strada.sh/sdk`, which removes about 12 MB of OpenTelemetry dependencies. The SDK no longer installs its own `uncaughtException` handler that could exit the bot before Kimaki's crash handler finished.

11. **Fixed short final replies that stayed quoted.** One-line progress updates stay quoted while the run is active, then the final reply goes back to full width. Multi-line replies are full width from the start.

12. **Fixed wrong `task-1` prefixes on subagent tool calls** when a child session starts before its task metadata arrives. Tool lines now show the agent name and the correct task number.

## 0.30.1

1. **`/abort` now also clears the thread `/queue`**, like `/clear-queue` does. Before, queued messages survived an abort: they were sent right after it, or restored from SQLite and sent after a Kimaki restart. Now abort removes them from memory and from the database, and the reply says how many were dropped:

   ```
   Request **aborted**, cleared 2 queued messages
   ```

2. **Child threads link back to their parent thread.** Threads started with `kimaki send --parent-session` show `Parent thread: #thread-name` as a clickable link in the starter message embed, so you can jump back to the thread that spawned the session. Works for direct sends and scheduled `--send-at` tasks. The link appears only when the parent session is bound to a thread on the same machine.

   ```bash
   kimaki send --channel <channel_id> --prompt 'Fix the auth bug' --parent-session ses_xxx
   ```

3. **Tool calls, thinking, and task lines are now dimmed as Discord subtext**, so assistant text stands out. Bot status lines (banner, footer, context usage, queue notices, retries) are plain subtext with no glyph. Only tool-related status lines like `bash returned N tokens` keep the `⬦` glyph, so it lines up with the `┣` and `◼︎` tool prefixes.

   ```
   -# *using openai/gpt-5.6-sol ⋅ build*
   -# ┣ skill _changesets_
   -# ◼︎ apply_patch *thread-session-runtime.ts* (+14-10)
   -# ⬦ bash returned 12k tokens
   -# Queued message (position 1)
   -# *kimakivoice ⋅ main ⋅ 2m 30s ⋅ 71% ⋅ gpt-5.6-sol*
   ```

4. **`prompt cache missed` notice now shows for every real cache miss**, right after the first reply to a new user message. Before, many misses were hidden: the check used the last reply of a turn (which reads back the cache the turn just wrote), a second Anthropic miss in a row was skipped, an aborted reply hid the next notice, and any slightly smaller prompt was treated as pruning. Now only real pruning and compaction hide the notice, and `/undo` does not show a false miss.

## 0.30.0

1. **Footer mentions are now opt-in.** Final session footers no longer ping the thread creator by default. Pass `--enable-footer-mentions` to get the old behavior:

   ```bash
   kimaki --enable-footer-mentions
   ```

   The old `--skip-footer-mentions` flag is removed. If you used it, just drop it, since no mention is now the default.

2. **Silent notice when prompt cache is lost mid-session.** Kimaki compares `tokens.cache.read` on consecutive completed assistant messages of the same model. If cached input drops while the prompt did not shrink, it posts a silent line:

   ```
   -# prompt cache missed (20k → 0), system +4 -1
   ```

   `system +4 -1` appears when the OpenCode system prompt changed. The full unified diff is written to `~/.kimaki/cache-rewrites/<time>-<session>.patch`, so you can see which plugin or agent prompt broke the cache. The check is skipped on the first assistant message, model changes, aborts, compaction, pruning, and any smaller prompt.

3. **`kimaki session read` is much cheaper for agents to load.** Thinking is omitted unless you pass `--thinking`. Compact tool lines truncate input to 80 characters (change it with `--tool-input-max-chars`). `--verbose` still dumps full tool YAML.

   ```bash
   kimaki session read ses_xxx > ./tmp/session.md
   kimaki session read ses_xxx --thinking --verbose
   ```

   Headings and tool lines use stable prefixes with no emoji: `### user`, `### assistant`, `tool:`, `tool-error:`. Compact `read` lines show the file base name, `task` lines keep the description and child `ses_` id, and `bash` lines show the command when it fits, otherwise the description. Agents are told to read the whole transcript when it is under 100 KB.

4. **`kimaki session wait` and `send --wait` stop at pending questions.** A session waiting on a `question` tool never finishes on its own, so waits now return the transcript at that point. `kimaki session list` shows these sessions as `status: showing-question`, and `--active` excludes them.

5. **Discord system lines use `-# ` subtext.** The new-session model banner, turn footer, queue notices, context usage, retries, and sleep wake now start with `-# ` instead of a quote or diamond. When a turn ends, the last assistant text is edited back to full width. Short status text stays quoted only while the turn is still running.

   ```
   -# *using openai/gpt-5.6-sol ⋅ gpt5*

   I'll inspect the file.

   -# *kimakivoice ⋅ main ⋅ 2m 30s ⋅ 71% ⋅ gpt-5.6-sol*
   ```

6. **Clean up local state when Discord channels and threads are deleted.** Kimaki removes stale project mappings, channel preferences, forum sync config, queued messages, pending interactions, sleeps, and scheduled deliveries that can no longer reach Discord, and stops active runtimes of the deleted threads. On startup it also removes saved channel mappings that Discord confirms no longer exist. Temporary API failures keep the mapping.

7. **Fixed Claude Pro/Max sessions with Anthropic.** Kimaki and the bundled Subrouter now advertise Claude Code `2.1.280`, so Anthropic no longer rejects newer models with `Claude Code 2.1.257 does not support this model`. Login and token refresh no longer fail with `Authorization code was invalid or expired` (the token endpoint returned a fake 429 to the OpenCode user-agent). If `auth.json` loses its `anthropic` entry, sessions now report that the login is missing instead of crashing with `undefined is not an object (evaluating 'auth.type')`. Run `/login` and pick **Claude Pro/Max** to log in again.

8. **Fixed voice transcription.** OpenAI voice notes no longer fail with `Invalid JSON response`. Transcription now uses `gpt-audio-1.5` for OpenAI and `gemini-flash-latest` for Gemini.

9. **Fixed Kimaki failing to start with `Port 29988 still in use after eviction`.** Ctrl+C, `SIGTERM`, or closing the terminal during startup was ignored, so the old process kept the lock port. Now:

   - stop signals end the bot cleanly at any point of startup
   - a new `kimaki` start force-kills an old instance that does not exit within 20 seconds
   - if the restart wrapper dies, the bot process exits too instead of staying orphaned on the port

10. **Fixed `. queue` messages interrupting a running `task` subagent.** Queued follow-ups now wait until the parent task actually finishes.

11. **Fixed question answers lost after an abort in another client.** If the session was aborted elsewhere, answering the Discord dropdown now resumes the session with your answers instead of silently dropping them.

12. **Subrouter cooldown fallback notices show as silent Discord lines** and never enter the model context. OpenAI WebSocket `1006` drops now retry on the same subscription instead of rotating the account.

13. **Quieter scheduled tasks.** Autonomous scheduled runs stay out of your Discord sidebar by default. The agent mentions you only when it completed work worth reviewing, found an issue, or needs a decision. Runs with no work archive themselves.

## 0.29.0

1. **Continue a thread on another computer with `kimaki thread list`.** Session IDs live only in the SQLite database and OpenCode server of the machine that created them, but Discord thread IDs work everywhere. Find a remote channel, list its threads, then send by thread ID:

   ```bash
   kimaki project list --all --json
   kimaki thread list --channel <channel_id> --json
   kimaki send --thread <thread_id> --prompt 'continue the work'
   ```

   The command lists active and recently archived public threads. Use `--thread`, not `--session`, for threads created on another machine. The system prompt now teaches agents to resolve a remote channel with `kimaki project list --all --json` (remote rows have no local directory, so `--project` and `--session` do not work for them).

2. **Each Kimaki machine gets its own Discord group.** New project channels now go into a Discord category bound to this machine by snowflake id, stored in local SQLite. A second install in the same server creates another **Kimaki** group instead of sharing the first one. You can rename those groups; Kimaki still uses the stored id. Existing installs adopt the parent of channels they already created, so current projects stay put.

3. **`/queue` messages now survive bot restarts.** Queued messages live in SQLite. After a restart, Kimaki restores them and sends the next one when the session is idle, keeping FIFO order. Remove-from-queue buttons still work after restart. This also fixes a startup crash on existing databases whose `thread_queue_items` table still used the old `queue_id` primary key (`SQLITE_ERROR: no such column: id`); Kimaki rebuilds that table before creating the new index.

4. **Richer `kimaki session list`.** Every row now shows `status: working` or `status: idle`, plus `tokens: N` when available (read straight from the session object, so the command stays fast). New `--all` flag lists sessions across every locally registered project. `--json` output gains `status`, `model`, and `tokens`.

   ```
   ses_abc | Fix auth timeout | /path/to/repo | 2026-01-01T00:00:00Z | (kimaki) | status: working | tokens: 84k | thread: 123456789012345678
   ```

5. **`/session-id` now shows the Discord thread ID** next to the OpenCode session ID, so you can attach to the session from any machine.

   ```
   **Session ID:** `ses_abc`
   **Thread ID:** `123456789012345678`
   ```

6. **Discord tool lines appear as soon as a tool starts.** Kimaki used to hold every part after unfinished assistant text, so a running tool waited for that text to end. Progress flush now holds only the open text part, so tool messages such as `┣ bash` show up immediately. Short text before sleep, question, or action-button tools still stays full width after those tools are sent.

7. **Fixed Discord replies disappearing behind Subrouter provider notices.** Kimaki keeps assistant text, tool calls, and completion output attached to the active user turn while still hiding internal notice messages from turn selection.

8. **Synthetic user prompt context no longer leaks into Discord.** Injected parts such as `[current git branch is main]` and `<discord-user />` stay hidden. Subrouter fallback notices still post as silent bot messages.

9. **Fixed `kimaki upload-to-discord` posting into the parent thread from `/btw` and `/fork` sessions.** Forked sessions copy the parent system prompt, so `--session` still names the parent. Bash now injects the live OpenCode session ID and upload prefers it, and each turn repeats the live session ID and Discord thread ID in synthetic context.

   ```bash
   # still write --session; bash uploads to the current thread anyway
   kimaki upload-to-discord --session ses_parent /tmp/shot.png
   ```

10. **Keep OpenCode subagents working when a model invents an invalid `task_id`.** Kimaki now strips task resume IDs that lack OpenCode's `ses` prefix before the `task` tool runs, so valid sessions still resume. Works around [anomalyco/opencode#49599](https://github.com/anomalyco/opencode/issues/49599), where Grok supplies random UUIDs for the optional field.

## 0.28.0

1. **Make Discord turns easier to scan.** Assistant text no longer starts with a diamond. Text and tools stay full width. When the part kind changes, Kimaki starts the next part with a blank line. Consecutive same-kind parts stay adjacent.

   Short completed text (at most two lines, no callout) is quoted as soon as it ends. Longer text, callouts, and text flushed for a question, sleep, or action-button tool stay full width. The new-session model banner and the completion footer are quoted too.

   ```
   > *using openai/gpt-5.6-sol ⋅ gpt5*

   I'll inspect the file.

   ┣ bash ls
   ◼︎ src/foo.ts

   Done.

   > *kimakivoice ⋅ main ⋅ 2m 30s ⋅ 71% ⋅ claude-opus-4-6*
   ```

   Line prefixes:

   ```
   ┣  tools and thinking
   ◼︎  file edits, writes, patches
   ⬦  status, context, worktree
   »  queued user input
   ```

   Long bash commands show a short **description** in Discord instead of the full command. Tool calls flush while the turn is still running. Agents are told to stay quiet between tool calls, so Discord no longer fills with "I'll read the file" narration.

2. **Search past sessions across projects, limited to recent work by default.** `kimaki session search` now scans the last **14 days**. Pass `--days 0` for all time, or `--all` to search every locally registered project.

   ```bash
   kimaki session search "auth timeout"
   kimaki session search "auth timeout" --days 0
   kimaki session search "/panic|crash/i" --all --json
   ```

   `--all` cannot be combined with `--project` or `--channel`. Missing or unreachable projects are skipped. `--json` includes the `days` field used for the scan. Titles prefixed `btw:` are side-question forks, not duplicate sessions.

3. **Set thinking level when you switch agents.** `/plan-agent`, `/build-agent`, and other `xxx-agent` slash commands now take an optional **variant** after **prompt**. Autocomplete lists the thinking levels for that agent's model.

   ```
   /plan-agent variant: high
   /build-agent prompt: fix the login bug variant: max
   ```

4. **Capture a CPU profile from a running bot.** In the terminal where Kimaki is running, type `cpuprof` and press Enter. Type it again to stop, or wait 20 seconds for auto-stop. The profile is written to `~/.kimaki/cpu-profiles/` (or `<data-dir>/cpu-profiles/`). Open the `.cpuprofile` file in Chrome DevTools or with `bunx profano`. Stdin must be a TTY. Heap snapshots still use `kill -SIGUSR1`.

5. **Keep scheduled work out of the Discord sidebar when you want it quiet.** Omit `--user` on `kimaki send --send-at`. Clear a stored user without deleting the task:

   ```bash
   kimaki send --channel <id> --prompt 'Read tasks/daily-digest.md' --send-at '0 21 * * *'
   kimaki task edit 11 --user ''
   ```

   A `-` in `kimaki task list` still means nobody is added when the task fires. Scheduled-task sessions also get a system-message section with the task ID, cron expression, and an instruction not to use `kimaki_sleep` between runs.

6. **Route voice into a side chat or a fresh session only when you ask.** Conversational phrases such as "by the way" no longer create a thread. Say you want a new chat, session, or thread. A plain new-chat request starts without history. A contextual side chat still needs a source session. Pending questions, permissions, and action buttons stay in the source chat. Long request overflow stays in the destination thread.

7. **Keep `/btw` from freezing the original thread.** `/btw` still does not abort the parent OpenCode run. The fork no longer fills the parent's 1000-event buffer with the clone flood. Kimaki buffers only the current thread session and its task/subagent children, binds the child session id before the SSE listener starts, and drops scoped events until that id exists.

8. **Keep Discord as the only writer for live Kimaki threads.** Finished Discord sessions are no longer re-posted as if they were OpenCode TUI sessions. Compaction user messages and compaction summaries stay out of Discord ownership and mirroring. Delegated task child sessions are ignored by parentID, so the parent thread no longer gets the subagent's full internal response. Compaction summaries also stay out of reply rendering so the real assistant continuation can finish. Fixes [#213](https://github.com/remorses/kimaki/issues/213).

9. **Reject OpenCode 2.x at bot start.** Kimaki still talks to OpenCode 1.x. If `opencode --version` reports `2.x.x`, Kimaki exits with:

   ```
   Kimaki is not compatible with OpenCode version 2.0.0. Install an OpenCode 1.x release.
   ```

10. **Restore session footers after every completed assistant turn.** Completed turns again post `folder ⋅ branch ⋅ duration ⋅ context% ⋅ model`. The final footer mentions the first human thread member, not the bot. Intermediate footers stay silent while the queue still has work. Sleep-turn waiting footers stay silent. Use `--skip-footer-mentions` if you want the footer without a ping.

11. **Keep Subrouter fallback notices visible without aborting work.** Display-only plugin notices such as `Subrouter: Using openai/gpt-5.6-sol because xai/grok-4.6 is rate limited.` post as silent bot messages. They no longer abort a busy session, including oracle subagents. `/model` and footers show the live Subrouter model, for example `subrouter/build (opencode-go/fake-model)`. Claude Pro and Max requests now use the current Claude Code client identity.

12. **Keep Discord arrival order for one-shot agent and command slash calls.** `/plan-agent` then an immediate text no longer races the previous agent. The same order applies to one-shot `/foo-cmd` and `/foo-skill`. `/model`, `/agent`, and `/compact` are not held on this queue.

13. **Make `kimaki project add` fail when the folder is already registered.**

    ```
    kimaki project add /path/to/repo
    Channel already exists for this directory: /path/to/repo
    Channel ID: 123
    Remove the mapping first: kimaki project remove 123
    ```

14. **Show the OpenCode SDK error when session create fails.** Discord now includes the OpenCode error name, message, and log ref instead of `session.create returned empty data`:

    ```
    Failed to create session: UnknownError: Unexpected server error. Check server logs for details. (err_58d6c6cf)
    ```

15. **Clean leftover `part_messages` rows** when a Discord thread mapping is gone. Fixes [#207](https://github.com/remorses/kimaki/issues/207).

16. **Keep OpenCode callout markup out of Discord thread names.** Fixes [#209](https://github.com/remorses/kimaki/issues/209).

17. **Stop treating a `kimaki_sleep` tool result as a wake.** Write one short waiting line, then stop. Keep waiting until a later Discord message that starts with **Woke after sleeping until**. A new user message cancels the sleep. If the later wake is still needed, call `kimaki_sleep` again with the original `until` time.

18. **Soften the tunnel system prompt** so wrapping a dev server in `kimaki tunnel` is a preference, not a hard ALWAYS/NEVER rule.

## 0.27.0

1. **Pool all AI subscriptions with Subrouter:** `/login` now shows **Subrouter** first. Add multiple accounts from multiple providers, then use `subrouter/default` or a custom preset. Subrouter first rotates accounts inside one provider, then moves to the next provider.

   ```text
     model: subrouter/default
          │
          ▼
     anthropic/claude-opus-4-6 ──429──▶ second Claude account
                                                │
                                                ▼
                                      openai/gpt-5.5
                                                │
                                         exhausted
                                                ▼
                                         xai/grok-4.6
   ```

   Cooldowns are shared by all sessions on the machine. Subrouter uses `retry-after` or `retry-after-ms` when the provider sends one, including zero. Without a usable retry delay, the fallback is five minutes. A `402` balance-exhausted response uses a six-hour cooldown.

   ```bash
   npx -y @subrouter/cli status
   npx -y @subrouter/cli cooldown clear

   npx -y @subrouter/cli preset create fast \
     --models 'anthropic/claude-opus-4-6,xai/grok-4.6'
   ```

   Kimaki also shows the current routed model in `/model` and final footers. Published builds register the exact `@subrouter/opencode` package identity, so OpenCode deduplicates Kimaki and user plugin declarations. Rate-limited task subagents stay active so Subrouter can finish account rotation or cross-provider failover. Existing `kimaki multioauth` commands remain available as legacy single-provider rotation.

2. **Put sessions to sleep and resume them later:** the new `kimaki_sleep` tool lets a session pause for hours or days, go idle without using tokens, and wake in the same session with its full conversation history.

   Ask for it in plain language:

   > deploy is running, check back in 2 hours and confirm it went green

   The tool accepts either a relative `duration` or an absolute UTC `until` value:

   ```text
   duration: 30s | 10m | 2h | 1d
   until:    2030-01-01T09:00:00Z
   reason:   waiting for the deploy
   ```

   Sleeps survive bot restarts because they are stored in SQLite. Delivery uses a stable Discord-compatible nonce and retries safely. A new chat message, `/queue`, `/abort`, a slash command that starts a new turn, or `kimaki send` cancels the pending sleep. `/btw` does not cancel it because `/btw` starts a separate side conversation.

3. **Merge worktrees with rebase or squash:** `/merge-worktree` now offers **Keep commits (rebase)** and **Squash into one commit** strategies. Squash mode rebases first, then creates one target commit, so the existing agent-assisted conflict flow still works.

   ```text
   /merge-worktree strategy:Squash into one commit target-branch:main
   ```

   The same merge pipeline is available from the root CLI:

   ```bash
   kimaki merge-worktree --strategy squash --target-branch main
   ```

   If a rebase has conflicts, Kimaki asks the agent to resolve them, continue the rebase, and retry the command. A successful retry clears the worktree marker from the Discord thread title. Completion messages include the source commit count.

4. **Coordinate concurrent sessions from the CLI:** active-session filtering, file editor attribution, and explicit title updates make parallel agent work easier to manage.

   ```bash
   kimaki session list --active

   while kimaki session list --active \
     --exclude "$CURRENT_SESSION_ID"; do
     sleep 5
   done

   kimaki session editors src/cli.ts
   kimaki session editors src/cli.ts --json

   kimaki session title 'Fix queue draining' --session ses_xxx
   ```

   `--active` includes each selected session status and exits with status `1` when no matching active sessions remain. Editor tracking records successful `edit`, `write`, and `apply_patch` calls. Session title updates change the OpenCode title, and the mapped Discord thread follows it.

5. **Expose the OpenCode server for remote attachment:** add `--opencode-hostname` and `--opencode-port` for remote OpenCode clients.

   ```bash
   OPENCODE_SERVER_PASSWORD=replace-me \
     kimaki --opencode-hostname 0.0.0.0 --opencode-port 4096

   opencode attach http://YOUR_VPS_IP:4096 --password replace-me
   ```

   These flags only control the OpenCode child server. Kimaki's lock and Hrana servers remain on `127.0.0.1`. Kimaki refuses a non-loopback OpenCode bind if `OPENCODE_SERVER_PASSWORD` is missing. `OPENCODE_SERVER_USERNAME` defaults to `opencode`. Without these flags, Kimaki explicitly binds OpenCode to `127.0.0.1` on a random free port.

6. **Validate CLI model IDs before work starts:** Kimaki now validates `--model` against OpenCode's live provider and model list before sending prompts, creating or editing tasks, and starting sessions.

   ```bash
   kimaki send \
     --model anthropic/claude-opus-4-6 \
     --prompt 'review this'

   kimaki task edit 12 --model openai/gpt-5.4
   ```

   Invalid values fail immediately with provider or similar-model hints. The required format is `provider/model`. An empty `--model` value on `task edit` still clears the task override.

7. **Notify thread creators when final work completes:** the final session footer now mentions the thread creator, which creates a Discord completion notification. Intermediate footers stay silent while queued messages remain.

   Use the new root flag to keep final footers visible without mention notifications:

   ```bash
   kimaki --skip-footer-mentions
   ```

   Footer mentions remain enabled by default.

8. **Add a ground-truth bug-report workflow:** the public guide covers event-stream export, logs, session Markdown, exact prompts, exact model IDs, and secret gists.

   ```bash
   kimaki session export-events-jsonl \
     --session ses_xxx \
     --out ./tmp/ses_xxx.jsonl

   kimaki session read ses_xxx > ./tmp/ses_xxx.md
   kimaki --version
   ```

   `kimaki session read` now includes the exact `providerID/modelID` in each assistant heading.

9. **Repair incomplete `kimaki@0.26.0` npm installations:** standard npm installs now declare `@subrouter/opencode` as a runtime dependency. The generated `schema.sql` also matches every table in the current Drizzle schema and includes `session_sleeps`. Regression tests cover both package contracts. Fixes [#199](https://github.com/remorses/kimaki/issues/199).

10. **Keep AskUserQuestion prompts available and correctly ordered:** AskUserQuestion dropdowns no longer expire after ten minutes. A question remains active until the user answers it, sends a newer message, or runs `/abort`.

    Assistant text emitted before a question now appears before the dropdown and before a queued `» user:` handoff. If Kimaki restarts and retains an old unanswered `question.asked` event, a newer user turn makes that old question inactive. `/abort` clears the pending dropdown. If Discord cannot send the dropdown, Kimaki clears its context and aborts the blocked OpenCode session. Permission prompts still keep their configurable timeout. Fixes [#192](https://github.com/remorses/kimaki/issues/192).

11. **Keep worktree creation bound to the correct checkout:** worktree setup now binds each request to the exact registered project checkout and resolved commit SHA. Kimaki verifies the Git common directory, linked-worktree identity, requested `HEAD`, and submodule ownership before the session starts. A mismatch is cleaned up and reported instead of starting work in an independent clone of the same remote.

    Kimaki also copies the source model, applies permissions, and binds the forked OpenCode session before the worktree becomes usable. An immediate message can no longer race setup and start a replacement session with the channel default model.

12. **Recover from Discord outages and stuck self-restarts:** Discord connect timeouts and temporary Undici socket errors now use a temporary-failure exit code. The restart wrapper retries with progressive backoff and does not count a long network outage as a crash loop.

    Self-restarts also have a 15-second exit deadline. If cleanup finishes but Node hangs while joining native worker threads, Kimaki force-kills the correct child generation and continues the restart. Thanks [@Cyberlane](https://github.com/Cyberlane) for [#190](https://github.com/remorses/kimaki/pull/190).

13. **Show delegated tasks when they start:** Kimaki now posts each delegated task line as soon as OpenCode marks it running. It no longer waits for a child session ID, so large task batches show tasks that are waiting for an OpenCode subagent slot.

    OpenAI task names can come from `state.title` instead of `input.description`; Kimaki supports both:

    ```text
    ┣ general **Classify pending changes**
    ```

    Completed task events do not post a late duplicate after the agent's follow-up text.

14. **Route resumed sessions to the current Discord thread:** `/resume` can map one OpenCode session to several historical Discord threads. Reverse lookup now selects the most recently bound thread. `kimaki_file_upload`, `kimaki_action_buttons`, sleep wakes, and other session-to-thread operations no longer post into an old thread and wait for interaction there.

15. **Keep sessions running when threads are archived:** archiving a Discord thread no longer aborts its mapped OpenCode session. Active work and queued prompts continue in order.

    To stop the run explicitly:

    ```bash
    kimaki session abort <session-id>
    ```

16. **Keep video uploads out of voice transcription:** `.mov`, `.mp4`, and other video attachments are no longer treated as voice notes only because Discord includes a duration. Voice notes and uploaded audio (`.ogg`, `.m4a`, `.mp3`, `.wav`, `.oga`, `.opus`) still transcribe.

17. **Render compact callouts correctly:** single-line callout blocks now render as Discord Components V2 containers instead of showing raw tags.

    ```html
    <callout accent="#f59e0b">Confidence: high.</callout>
    ```

    Callout syntax inside fenced code remains literal. Nested, adjacent, or malformed one-line callouts remain plain text instead of producing an incorrect container.

18. **Show useful worktree merge failures:** `/merge-worktree` and `kimaki merge-worktree` now show the failed Git command, exit code, stderr, stdout when useful, and remaining cause details. When the final local target update fails after a successful rebase, Kimaki explains that the worktree rebase is preserved, the local target branch was not updated, and no push to origin occurred.

19. **Count delegated task tokens accurately:** Strada `tokens_used` events now include billed usage from task child sessions, not only the parent session. Child idle events report their own usage, while the parent reports any remaining child delta without double-counting.

## 0.26.0

1. **xAI (Grok) multi-account OAuth rotation** — kimaki now rotates xAI accounts the same way it already rotates Anthropic and OpenAI accounts.

   When an xAI account hits its usage limit (402 "balance exhausted" or 403 "spending-limit"), kimaki switches to the next account in the rotation pool and resumes the session.

   ```bash
   # List all xAI accounts in the rotation pool
   kimaki multioauth xai list

   # Show the current active account
   kimaki multioauth xai current

   # Remove an account by index or email
   kimaki multioauth xai remove 2

   # Test all accounts for usage limits
   kimaki multioauth xai check
   ```

   New accounts are detected automatically when you log in via `/login` in Discord. The rotation pool is stored at `~/.local/share/opencode/xai-oauth-accounts.json`.

   This release also enables the OpenAI rotation plugin, which existed but was never wired into the plugin loader.

2. **Conditional and non-overlapping scheduled tasks** — use `--pre-run` to run a shell command in the project directory before each scheduled occurrence. Exit code 0 starts the session and adds stdout to its prompt. Any other exit code skips the occurrence. Stdout and stderr stay in the Kimaki log.

   ```bash
   kimaki send --channel <channel-id> \
     --send-at '*/5 * * * *' \
     --pre-run 'tsx scripts/should-run.ts' \
     --prompt 'Handle the support request from the pre-run output.'
   ```

   Recurring tasks now avoid overlapping sessions by default. If one occurrence still has an active session, Kimaki skips the next tick. Add `--allow-concurrency` to opt into parallel runs from the same task.

   ```bash
   kimaki task edit <id> --pre-run 'tsx scripts/should-run.ts'
   kimaki task edit <id> --allow-concurrency true
   ```

3. **`kimaki tunnel` now prints both the localhost URL and the public tunnel URL** after it connects.

   Never use the tunnel URL for local testing. Use localhost instead; it is much faster. The CLI still prints the tunnel URL so people who are not on the same machine can open the app.

   ```
   Connected with Traforo!

   Local:  http://localhost:5173
   Tunnel: https://abc123-tunnel.kimaki.dev

   NEVER use the tunnel URL for local testing. Use the local URL instead; it is much faster.
   Always show both URLs to the user. The local URL works when they are on the same machine.
   ```

4. **Refresh the agent model when you run `/agent` or `/xxx-agent`**, even if that agent is already selected.

   This matters when the agent file changed, or when a leftover thread `/model` override is still pinned. The command now clears the session model copy and shows which model will be used next, plus **why**:

   ```
   Using **plan** agent for this session
   Model: *anthropic/claude-sonnet-4* (agent "plan")
   The agent will change on the next message.
   ```

   If a **session** or **channel** `/model` override is the reason that model is selected, the reply tells you to run `/model` and press **Clear override** so the agent's own model can apply.

   `/model` on this thread still beats the agent model. The agent's model still beats a channel or global `/model`.

5. **Stop inlining large Discord text attachments into the model prompt.**

   Every text attachment is saved under `~/.kimaki/attachments/`. The prompt always includes the local path and Discord URL. Files over 64 KB omit the file contents and tell the agent to read the local path. Small text files and `prompt.md` from `kimaki send` still inline as before.

6. **`question`, `kimaki_action_buttons`, and `kimaki_file_upload` now run last**, after all text.

   Calling these tools first hid the assistant message behind Discord dropdowns and buttons.

7. **Show delegated task parts in Discord** when OpenAI provides the task description only as the completed tool title.

   Task calls now appear as `┣ general **Classify pending changes**` instead of being omitted from the thread.

8. **Keep raw Discord user IDs separate from usernames** when `kimaki send --user` and `kimaki task edit --user` create session metadata. Kimaki now includes `userId` without inventing a numeric `username` when only an ID or mention is available.

9. **Fix parallel `kimaki send` failures** when multiple long prompts are dispatched at once.

   Long prompts used to be written to a shared temp path and unlinked after upload. Concurrent sends from the same working directory could race on create/cleanup and fail with `ENOENT` before the Discord thread was created.

   Long prompt attachments now build `prompt.md` in memory and upload it directly. No temp file is created, so parallel sends cannot delete each other's attachments.

   ```bash
   # safe to run many long prompts at once
   kimaki send --channel <id> --prompt "$(cat long-task-1.md)" &
   kimaki send --channel <id> --prompt "$(cat long-task-2.md)" &
   wait
   ```

## 0.25.0

1. **Allow every directory by default, remove `/add-dir`** — OpenCode's `external_directory` permission defaulted to `ask`, so reading anything outside the project put an approval prompt in the thread. That prompt fired constantly for ordinary work (reading a sibling repo, a config file, a cached dependency), and if nobody clicked it within the permission timeout the tool call was rejected. Kimaki worked around it with a growing allow-list, an `/add-dir` command, and auto-granting directories from `#channel` mentions.

   All of that is gone. **External directory access is now `allow` for every path.**

   Kimaki writes `"external_directory": { "*": "allow" }` into its generated config. To protect specific folders, put `deny` or `ask` rules in your own `opencode.json`. Project config merges on top of that wildcard and the last matching rule wins, so your rules take priority while unlisted paths stay allowed:

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "permission": {
       "external_directory": {
         "~/.ssh": "deny",
         "~/.ssh/*": "deny",
         "~/Documents/*": "ask"
       }
     }
   }
   ```

   **New `--restrict-directories` flag** restores the old behaviour if you want it globally:

   ```bash
   kimaki --restrict-directories
   ```

   The agent is then limited to the session working directory plus a few known-safe paths (`/tmp`, `~/.config/opencode`, `~/.opensrc`, `~/.kimaki`, and common toolchain caches). Everything else asks for approval in the thread.

   **Removed:**

   - `/add-dir` slash command. It only existed to widen a session past the `ask` default, which no longer applies.
   - Auto-granting a referenced project's directory when you mention `#channel` in a message. Mentions still resolve normally; they just no longer carry permission side effects.

   Worktree threads still deny the original checkout with or without the flag. That rule is directory isolation, not prompt avoidance: it keeps the agent from editing the main repo after the thread moved to a worktree. It is applied at session level so it also beats your `opencode.json`; only an explicit `--permission 'external_directory:allow'` on that session can override it.

2. **Free Whisper transcription fallback for gateway-mode installs** — voice message transcription now works out of the box, even with no OpenAI or Gemini API key configured.

   When a gateway-mode bot has no transcription key set, the CLI falls back to a free Whisper transcription endpoint on `kimaki.dev`, backed by Cloudflare Workers AI (`@cf/openai/whisper-large-v3-turbo`). This is authenticated with the same `clientId:clientSecret` credentials already used for gateway-proxy calls, so no extra setup is needed.

   ```
   gateway-mode bot, no API key
           │
           ▼
   kimaki.dev /api/transcribe  ──►  Cloudflare Workers AI (Whisper)  ──►  transcription text
   ```

   If this free fallback is rate-limited or unavailable, the CLI still falls back to the existing "add API key" button so you can bring your own OpenAI/Gemini key for full context-aware transcription (which supports detecting `/queue` and agent hints spoken in the voice message — the free fallback does not).

   Self-hosted bot installs are unaffected; this only applies to gateway mode, since it requires a registered `client_id`.

3. **Restored `/model-variant` and `/clear-queue` slash commands** — they were removed in favor of buttons attached to `/model` and `/queue` replies, but a direct command is still handy when you already know what you want to change without waiting for a reply message:

   ```bash
   /model-variant          # pick a thinking level for the current model
   /clear-queue             # clear all queued messages in this thread
   /clear-queue position:2  # clear only the message at queue position 2
   ```

   The button-based flows on `/model` ("Change thinking level") and `/queue` ("Remove from queue") still work as before.

4. **Fixed `sendMessage` failing with a Discord 400 error when rendering long markdown tables.** Tables with many rows and long cell values (for example `/worktrees` or `/tasks` output with long paths) could stay under Discord's 40-component budget while still exceeding the 4000-character total text limit for Components V2 messages. That combination silently failed to send. Table rows are now chunked by both the component count budget and the text size budget, splitting large tables across multiple messages when needed. A single row whose own content exceeds 4000 characters is also clamped instead of being sent as-is.

## 0.24.0

1. **Anonymous usage analytics via Strada** — Kimaki now measures install activity, projects, sessions, and turns without collecting personal data. A random install id is stored in `~/.kimaki/install-id` (or your `--data-dir`), and only these product events are emitted:

   - `bot_started` when the Discord bot is ready
   - `project_registered` when a project channel is mapped (`user` vs `default`)
   - `session_created` when a new OpenCode session is created
   - `turn_started` when OpenCode accepts a prompt or command (with `source` so retries can be excluded from DAU)
   - `turn_completed` on natural visible completions

   No Discord IDs, paths, prompts, or secrets are sent. Metrics are **active installs**, not people. Disable with `kimaki --no-analytics` or `KIMAKI_STRADA_ENABLED=0`.

2. **`KIMAKI_NO_DEFAULT_CHANNEL` env var for managed deployments** — disable automatic creation of the default Kimaki channel, welcome message, and tutorial thread when your deployment provisions project channels itself:

   ```bash
   KIMAKI_NO_DEFAULT_CHANNEL=1 kimaki
   ```

   Fixes [#175](https://github.com/remorses/kimaki/issues/175).

3. **Fewer Discord slash commands, same functionality** — secondary actions moved onto parent message buttons to free up command slots:

   | Removed | Replacement |
   |---|---|
   | `/screenshare-stop` | **Stop screen share** button on `/screenshare` reply |
   | `/model-variant` | **Change thinking level** button on `/model` |
   | `/unset-model-override` | **Clear session/channel override** button on `/model` |
   | `/toggle-worktrees` | **Turn on/off** auto-worktrees control in `/worktrees` |
   | `/clear-queue` | **Remove from queue** button on each `/queue` confirmation |

   `/vscode` also gained a **Stop VS Code** button. When Discord's 100-command limit is hit, registration priority is now: built-ins → agents (`*-agent`) → user commands → MCP prompts → skills (trimmed first).

4. **Scheduled tasks show who gets notified** — `kimaki task list` now prints `userId`, `agent`, and `model` columns, so you can spot tasks that notify nobody:

   ```
   id | status | message | channelId | userId | projectName | folderName | agent | model | ...
   5  | planned | Reply to unread emails | 1422... | - | my-project | GitHub | - | -
   19 | planned | Run daily news desk | 1532... | 5359... | chiavarinews | GitHub | - | opencode-go/deepseek-v4-flash
   ```

   A `-` in `userId` means no thread member gets added when the task fires, so it may go unseen.

   `kimaki task edit` can now set user, model, and agent on an existing task instead of delete + recreate:

   ```bash
   kimaki task edit 5 --user '535922349652836367'
   kimaki task edit 19 --model 'opencode-go/deepseek-v4-flash' --send-at '0 4 * * *'
   # empty string clears the override
   kimaki task edit 19 --agent ''
   ```

   `kimaki send --user` also now works with `--thread` and `--session`, re-adding the user as a thread member so scheduled thread reminders resurface a thread you left, even if it auto-archived.

5. **`/create-new-project` works from inside a thread** — previously it only worked from a text channel and replied with `This command can only be used in a text channel` when run from a thread. Now `/create-new-project name: my-new-app` works from either place, without interrupting the thread you're currently working in.

6. **Voice notes resume automatically after saving an API key** — if Kimaki needs an OpenAI or Gemini API key to transcribe your first voice note, saving the key now transcribes and sends that same note instead of asking you to record it again.

7. **`/abort` is easier to find** — its searchable description now includes stop, terminate, and cancel. Fixes [#176](https://github.com/remorses/kimaki/issues/176).

8. **Fixed missing system prompt on the first turn of OpenCode commands** — slash commands and leading `/command` messages now correctly get the Discord context Kimaki injects on normal turns (session/thread IDs, upload helpers, etc), since OpenCode's `session.command` API has no `system` field on its own.

9. **Fixed source builds failing due to a missing file** — `cli/src/analytics.ts` was referenced but never committed, breaking `pnpm --filter kimaki build` and `pnpm tsc` on a clean checkout. Published npm builds were unaffected since they ship a prebuilt `dist/`. Fixes [#182](https://github.com/remorses/kimaki/issues/182), fixes [#183](https://github.com/remorses/kimaki/issues/183).

## 0.23.1

1. **Removed retired skills from the npm package** — the bundled `batch`, `security-review`, and `simplify` skills no longer remain in fresh installs after being removed from Kimaki's skill set.

## 0.23.0

1. **Web search is available by default** — every Kimaki OpenCode session now enables the built-in Exa-powered web search tool without extra configuration or an API key. You can still set `EXA_API_KEY` for authenticated access and higher limits.

2. **Scheduled task prompts stay short and maintainable** — agents now put detailed recurring task instructions in a project file such as `tasks/weekly-test-suite.md`, then schedule a concise prompt that points to it:

   ```bash
   kimaki send --channel <channelId> \
     --prompt 'Read tasks/weekly-test-suite.md and follow instructions' \
     --send-at '0 9 * * 1'
   ```

   Agents also edit an existing cron task instead of creating duplicates when a task needs to run more often. For example, `0 9,18 * * *` runs one task at 09:00 and 18:00 UTC.

3. **`/clear-queue` shows what it removed** — clearing a thread queue now returns a numbered list of the discarded prompts and commands instead of only reporting the count.

4. **Deleted default channels stay deleted** — Kimaki no longer recreates the default project channel on startup after you intentionally remove it. The deletion is tracked independently for each Discord server.

5. **Forked worktree sessions consistently use the worktree checkout** — `apply_patch`, reads, edits, writes, and terminal commands no longer split operations between the new worktree and the source checkout.

6. **CLI subcommands reuse the running OpenCode server** — commands such as `kimaki session list`, `kimaki session archive`, and `kimaki send --wait` discover and health-check the bot's existing server instead of starting a redundant `opencode serve` process. Restarts now wait for the global event stream to reconnect before dispatching prompts, preventing replies and completion footers from being missed. Fixes [#170](https://github.com/remorses/kimaki/issues/170).

7. **Anthropic OAuth rotation recovers from expired refresh tokens** — accounts rejected with `invalid_grant` are removed from the rotation pool, then Kimaki switches to the next account and retries. If no accounts remain, authentication is cleared so you can log in again. Rate-limited accounts are still retained and rotated normally.

8. **One-time scheduled tasks are deleted after running** — completed one-shot tasks no longer accumulate in the local database or task listings. Cron tasks continue to reschedule normally.

9. **No empty completion footers** — when a model intentionally produces no visible text or tool output, Kimaki no longer posts a standalone session footer in Discord.

10. **Clearer worktree merge guidance** — agents in worktree sessions now use `kimaki merge-worktree` and retry after resolving rebase conflicts instead of leaving the merge workflow ambiguous.

11. **Clearer OAuth fallback action** — the login button now says **Paste authorization code or callback url**, matching the modal's existing support for either input.

## 0.22.0

1. **`--file` option for `kimaki send`** — attach local files (images, text files, PDFs) to Discord messages when creating threads or sending to existing ones.

   ```bash
   # Attach a screenshot to a new thread
   kimaki send --channel <channelId> --prompt 'Review this screenshot' --file ./screenshot.png

   # Attach multiple files to an existing thread
   kimaki send --thread <threadId> --prompt 'Here are the logs' --file ./error.log --file ./trace.txt
   ```

   Files are uploaded as Discord attachments on the starter message. Images and PDFs are passed to the AI model as visual context; text files are inlined into the prompt. File size is validated against Discord's 25 MB limit before upload. Not compatible with `--send-at` (scheduled tasks store prompts as text).

2. **`/new-session` now works inside threads** — previously `/new-session` only worked in text channels. When used in a thread, the new session inherits the same working directory (worktree or workspace), and the new thread is created in the parent text channel.

3. **`--all` flag for `kimaki project list`** — when multiple kimaki instances share the same Discord server (different machines), `--all` scans the Kimaki category to discover text channels created by other instances.

   ```bash
   # Show local projects only (default)
   kimaki project list

   # Include remote projects from other machines
   kimaki project list --all

   # Machine-readable with is_local field
   kimaki project list --all --json
   ```

   Remote projects show as `[remote]` with `(Not registered on this machine)` instead of a directory path. Use `--guild <id>` to specify which guild to scan when no local projects exist yet.

4. **Auto-resolve remote ref for worktree base branches** — when creating a worktree with `--base-branch main`, kimaki now fetches the latest from `upstream` (then `origin`) and uses the remote ref if it's strictly ahead of the local branch. Avoids creating worktrees from stale local branches. Explicit remote refs like `origin/main` are passed through unchanged. Closes [#138](https://github.com/remorses/kimaki/issues/138)

5. **Fix `/btw` and `. btw` suffix using wrong directory in worktree threads** — sessions forked via `/btw` or the `. btw` suffix, and user-defined OpenCode commands, now correctly use the worktree path instead of the base project directory.

6. **Fix `kimaki send --channel` ignoring worktree toggle** — `kimaki send --channel` now auto-creates worktrees when `/toggle-worktrees` is enabled for the channel or when the global `--worktrees` flag is set. Previously, worktrees were only created when `--worktree` was explicitly passed.

7. **Fix queue items removed by embed-only message updates** — Discord fires `MESSAGE_UPDATE` for link preview unfurling even when the user didn't edit the message. These events (`editedTimestamp = null`) no longer cause queued messages to be spuriously removed.

8. **Channel column in `/tasks` output** — scheduled task listings now show the associated Discord channel as a clickable mention between the Status and Prompt columns.

9. **Session ID shown alongside thread ID in system message** — agents now see both `--thread <threadId>` (preferred for cross-machine) and `--session <sessionId>` (fallback) in the system message, so they can reference the current session using either method.

## 0.21.0

1. **Guild name and ID in `kimaki project list`** — project listings now show which Discord server each channel belongs to, making it easy to distinguish channels with the same name across different servers.

   Human-readable output shows the server name next to each channel:

   ```
   #kimaki (Personal Server)
      Folder: kimaki
      Directory: /Users/morse/.kimaki/projects/kimaki
      Channel ID: 1505879613723906048
      Guild ID: 1422625037164351591
   ```

   JSON output (`--json`) includes two new fields (`guild_id`, `guild_name`). A warning is printed when the same directory is registered in multiple channels across guilds.

2. **New `kimaki project remove <channel_id>` command** — removes a single channel mapping from the local database without deleting the Discord channel. Useful for cleaning up duplicate or stale entries from multi-server setups.

3. **Parent session ID forwarding** — sessions started via `kimaki send` now pass `--parent-session <id>` so child sessions know who started them and can message back when asked.

   ```bash
   kimaki send --channel <channelId> \
     --prompt 'Help with this task' \
     --agent build \
     --parent-session ses_current
   ```

   Child sessions receive the parent ID in their system message with instructions on how to reply back.

4. **Run now button for scheduled tasks** — `/tasks` now shows a **Run now** button next to planned tasks so you can fire them immediately instead of waiting for the scheduled time.

   | Action | Button |
   | --- | --- |
   | Run early | **Run now** (planned tasks) |
   | Remove | **Delete** (planned or running) |

5. **Queue message deletion** — deleting a Discord message that is still waiting in the local queue now removes it before it drains into OpenCode. Previously, only editing a queued message to empty would remove it.

6. **Fix `kimaki send` crash in read-only directories** — long prompts (attached as files) now use `os.tmpdir()` instead of `process.cwd()/tmp`, so `kimaki send` works from read-only directories like `/var/www/`. Fixes [#159](https://github.com/remorses/kimaki/issues/159)

7. **Retry on Discord TLS certificate errors** — transient TLS failures like `unable to verify the first certificate` now exit with code 1 instead of 64 (`EXIT_NO_RESTART`), so the auto-restart wrapper recovers with backoff instead of stopping permanently.

8. **Fix setup commands in multi-machine mode** — `create-new-project` and `add-project` now work from any channel when multiple machines are connected to the same Discord server. Previously these commands were incorrectly blocked by the ownership check.

9. **Remove critique review instructions from system prompt** — the system prompt no longer includes the `bunx critique review --web` section (39 lines of instructions and 6 example commands), reducing prompt size.

## 0.20.1

1. **Fix user-defined commands not creating worktrees** — `-cmd`, `-skill`, and `-mcp-prompt` slash commands now correctly create worktrees in channels with worktrees enabled. Previously, running a command like `/review-cmd` would create a plain thread without a worktree, even though regular messages and `/agent` commands already respected the per-channel worktree setting.

2. **Fix bot not restarting after gateway reconnect limit without wrapper** — when running with `tsx src/cli.ts` (local dev, no `bin.ts` wrapper), the previous fallback used a detached `spawn()` + `process.exit(0)` which was unreliable. Now `selfRestart` always exits with code 1; the `bin.ts` wrapper catches it and restarts with exponential backoff and crash-loop detection. Running without the wrapper logs a warning suggesting `bin.ts`.

3. **Fail fast on oversized Discord file uploads** — `uploadFilesToDiscord` now checks each file's size before reading it into memory. If a file exceeds the bot limit (25 MB default, higher for boosted servers), it throws immediately with a clear error instead of sending to Discord and waiting for rejection.

4. **Add `description` field to bash tool prompt** — the system prompt now instructs models to always send a short `description` with each bash call. The field is shown in Discord as context for what the command does. The instructions are structured as a TypeScript interface so models follow the schema more reliably.

5. **Fix truncated bash commands missing ellipsis** — multiline commands displayed only the first line but without any visual indicator that the command was longer. Now always appends "..." when showing a partial command.

## 0.20.0

1. **Mention-prefixed messages now visible to the agent** — when a user sends a message in a thread that starts with `@mention` to another user (not the bot), it's added to the session context without triggering an AI response. The agent sees user-to-user conversation on the next turn, giving it better context about what's being discussed. Channel-level messages with leading mentions to other users are still ignored (no thread creation).

2. **Custom tools, MCP tools, and plugin tools shown in default verbosity** — the default `text_and_essential_tools` verbosity used a whitelist of known tool names, hiding any tool not in the list. Now the logic is flipped: only known read-only built-in tools (`read`, `glob`, `grep`, `describe-media`, `todoread`) are hidden. Everything else is shown by default.

3. **Fix `project add` and `project create` selecting wrong guild in gateway mode** — the guild selection heuristic fetched the most recent channel from the database, but that channel could belong to a different bot instance (e.g. old self-hosted bot). In gateway mode the proxy rejected the REST call and the fallback non-deterministically picked the wrong guild. Now multiple existing channels are tried before falling back to the guild cache, which in gateway mode is already filtered to authorized guilds.

4. **Fix quick agent commands not creating worktrees** — `/plan-agent <prompt>`, `/build-agent <prompt>` and other quick agent slash commands now correctly create worktrees when used from a project channel with worktree mode enabled. Previously these created plain threads without a worktree.

5. **Fix bash tool rendering with missing description** — newer opencode versions removed the `description` field from the bash tool schema, causing multiline or long commands to render as just `┣ bash` with no context. Now the first line of the command is shown truncated with `…` when no description is available.

## 0.19.0

1. **Compact session markdown export** — `kimaki session read` now renders tool calls as compact one-liners by default, showing the tool name, key parameters, and output line count instead of full YAML inputs and raw output blocks. This makes exported sessions much more readable and smaller, especially for sessions with many file reads and grep results.

   ```
   > 🛠️ **bash** command=echo hello, description=Print greeting (2 lines)
   > 🛠️ **read** filePath=src/config.ts (124 lines)
   ```

   Use `--verbose` to get the full tool output when you need it:

   ```bash
   kimaki session read <session-id> --verbose
   ```

2. **Fix `kimaki send` failing in CI/headless environments** — `kimaki send --channel <id> --prompt "..."` no longer requires a local SQLite database with channel-to-directory mappings. Previously, this mapping (populated when the bot runs locally) was required unconditionally, making it impossible to use `kimaki send` from CI runners or GitHub Actions. Now the local project directory mapping is only required for `--send-at`, `--wait`, and `--cwd`. The basic flow (post message, create thread, let the remote bot pick it up) works with just `KIMAKI_BOT_TOKEN`.

3. **Fix `--wait` and `--send-at` erroring after message was already sent** — the channel config requirement check now runs before posting the Discord message, so these flags fail early with a clear error instead of posting the message and then crashing.

## 0.18.0

1. **New `kimaki bot token` command** — prints the bot token for CI and automation use. In self-hosted mode it prints the Discord bot token; in gateway mode it prints the `clientId:clientSecret` credential.

   ```bash
   # Print your token (works in both self-hosted and gateway modes)
   kimaki bot token

   # Store it as a GitHub Actions secret
   kimaki bot token | gh secret set KIMAKI_BOT_TOKEN
   ```

   Set the output as `KIMAKI_BOT_TOKEN` in your CI environment to let `kimaki send` and other CLI subcommands authenticate without interactive setup.

2. **Harden gateway reconnect restart for sustained network outages** — previously, when the gateway proxy was unreachable (DNS down, network outage), kimaki would hit the 50-reconnect limit, trigger self-restart, crash during cleanup from uncaught discord.js shard errors, and permanently exit. Now uncaught exceptions during shutdown are suppressed, client listeners are removed before destroy, transient network errors on initial connection allow the wrapper to retry, and progressive restart backoff (2s → 4s → 8s → 16s, capped at 30s) prevents hammering DNS. The existing crash loop detector (5 crashes in 60s) still acts as the ultimate circuit breaker.

3. **Fix slash commands handled by the wrong machine in multi-machine setups** — when kimaki is installed on multiple machines sharing the same Discord guild via gateway proxy, interactions (slash commands, buttons, select menus, modals) were processed by every machine regardless of channel ownership. Now the interaction handler checks if the channel has a project directory configured in the local SQLite database before processing; if not, the interaction is silently ignored so the correct machine handles it.

4. **Fix workspace worktree setup and cleanup** — worktree creation now correctly parses `.gitmodules` inside the plugin-safe workspace adaptor so submodules initialize. Deleting a worktree from `/worktrees` now removes the matching OpenCode workspace record through the workspace SDK before deleting the local thread mapping, keeping OpenCode workspace state, git worktrees, and Kimaki thread metadata in sync.

5. **Fix multi-question Discord dropdowns submitting incomplete answers** — duplicate select interactions on one dropdown could submit empty answers for later questions. Kimaki now derives question completion from the actual answered question indexes instead of incrementing a counter.

6. **Add `--no-auto-upgrade` CLI flag** — disables the background auto-upgrade check on startup. Useful for pinned deployments or air-gapped environments.

   ```bash
   kimaki --no-auto-upgrade
   ```

7. **Fix gateway install URL on Windows** — the Discord OAuth install URL now opens correctly on Windows during onboarding. Thanks @TheLonelyDevil9 for #152!

## 0.17.1

1. **Fix gateway onboarding flow silently failing** — the CLI would get stuck on "Still waiting..." after the user authorized the bot. Discord doesn't always include `guild_id` in the OAuth callback URL (e.g. when previously authorized). Now the `guild_id` is cached in KV before the callback, `prompt` is set to `consent` so the authorization screen always shows, and specific onboarding errors are surfaced to the CLI instead of a generic timeout.

2. **Fix `/worktrees` and `/last-sessions` exceeding Discord limits** — these commands could exceed Discord's 40-component limit or 4000-char text limit for large worktree/session lists. Components are now truncated intelligently (removing rows from containers instead of dropping entire containers) with a notice showing how many items were hidden.

3. **Stop adopting another instance's default channel in shared guilds** — when two kimaki installations (different `client_id`) connected to the same Discord guild via the gateway proxy, the second instance would claim the first instance's "kimaki" channel. Each instance now only manages channels it created itself.

4. **Skip joining voice channels without an API key** — the bot no longer joins Discord voice channels when no Gemini API key is configured. Previously it would join and immediately fail. Now it logs a message telling the user to set an API key via `/audio-api-key`.

5. **Fix silent interaction errors** — interaction handler now properly distinguishes `deferReply` vs `deferUpdate` when following up, preventing "Unknown Webhook" errors on component interactions.

## 0.17.0

1. **xAI Grok Composer 2.5 Fast model available by default** — the `grok-composer-2.5-fast` model from xAI is now registered in Kimaki's default opencode config, so all users can select it via `/model` without manual configuration. 256k context, 256k output, supports attachments and tool calls.

2. **Forked sessions preserve the source model** — when `/btw` forks a side-question thread or `/new-worktree` creates a worktree from an existing thread, the new session now uses the same model as the source session instead of falling back to the default.

3. **Clear worktree marker on empty merge** — `/merge-worktree` now removes the worktree marker from a thread title when there are no commits to merge (branch is already up to date), instead of leaving it marked as unmerged.

4. **Improved `/btw` fork behavior** — forked sessions no longer proactively suggest sending messages back to the parent session. The agent only does so when the user explicitly asks.

## 0.16.0

1. **Gateway mode re-enabled in onboarding wizard** — the "Gateway (pre-built Kimaki bot)" option is available again when running `kimaki` for the first time. Discord raised the privileged intent threshold from 100 servers to 10,000 users on June 10, 2026, so the shared bot no longer needs verification.

2. **Long `--notify-only` messages are split instead of attached as files** — when `kimaki send --notify-only` has a prompt over 2000 characters, the content is now split into multiple Discord messages using the same markdown-aware splitter used in threads. Previously it was sent as a `.md` file attachment, making the content harder to read directly in the channel.

## 0.15.0

1. **New `kimaki session abort` command** — stop a running session without archiving the thread. The thread stays visible in Discord so you can inspect what happened. A "Session aborted via CLI" message is posted in the thread.

   ```bash
   kimaki send --channel 123 --prompt 'wrong stuff'
   # Output:
   # Session: ses_abc123
   # https://discord.com/channels/...

   kimaki session abort ses_abc123
   ```

2. **`kimaki send` now prints the session ID** — alongside the thread URL. For new threads, the CLI polls the database for up to 15 seconds waiting for the bot to create the session. For existing threads, the session ID is looked up immediately.

3. **Allow `--agent` and `--model` with `--thread`/`--session` in `kimaki send`** — previously the CLI rejected these flags for existing threads with "Incompatible options with --thread/--session". Now they are accepted and included in the thread prompt marker so the bot picks them up. Fixes #146

   ```bash
   kimaki send --thread 123456 --prompt 'fix the bug' --agent plan
   kimaki send --session ses_abc --prompt 'run tests' --model anthropic/claude-sonnet-4-20250514
   ```

4. **Allow `kimaki send --notify-only` to target any Discord channel** — previously every channel had to have a project directory mapping. Now `--notify-only` on a non-project channel posts the message directly without creating a thread. Scheduled tasks (`--send-at`) also work.

5. **Auto-reject permission requests in subagent sessions** — permission prompts from Task/subtask agents are now automatically denied instead of showing buttons that nobody clicks. This prevents subagent sessions from hanging indefinitely on permission prompts.

6. **Filter disabled skills from Discord slash command registration** — `--disable-skill` and `--enable-skill` flags now also prevent the corresponding skill commands from being registered as Discord slash commands, freeing up slots for commands the user actually wants. Fixes #145

7. **Parallelize `/btw` and `/new-worktree` commands** — session lookup, opencode init, and parent channel resolve now run concurrently in both commands, reducing latency.

8. **Pass parent session ID into `/btw`-forked sessions** — the agent in a forked session can now send messages back to the parent session using `kimaki send --session <parent_id>`.

9. **Clickable source thread links in fork/btw messages** — `/fork` now includes a clickable `<#threadId>` link to the source thread in the "Forked session created" message.

10. **Self-restart on gateway reconnect limit** — after 50 consecutive failed Discord gateway reconnect attempts, the process self-restarts using the same spawn-and-exit pattern as SIGUSR2 instead of retrying forever.

11. **Fix stale permission buttons when plugin auto-rejects** — permission buttons from previous prompts are now dismissed when the plugin auto-rejects.

## 0.14.0

1. **Configurable permission timeout with model continuation on deny** — new `--permission-timeout-minutes <minutes>` flag controls how long permission buttons stay active before auto-rejecting (defaults to 10 minutes). When a permission times out or the user clicks Deny, the model now sees it as a tool error and continues working (tries alternatives or explains what happened) instead of the session going dead silent. The timeout message also tells the model to mention the thread owner if the tool call is essential.

   ```bash
   kimaki --permission-timeout-minutes 30
   ```

   Closes #140

2. **Single global SSE connection replaces per-thread listeners** — previously every Discord thread opened its own SSE connection to the opencode server. With 20+ idle threads, all connections disconnected and reconnected simultaneously, flooding logs with reconnect messages. Now a single `/global/event` connection broadcasts events to all thread runtimes, matching how the opencode TUI works. Fixes #126

3. **Queue edit and removal notifications** — when a user edits a queued message in Discord, the thread now shows `⬦ **username** edited queued message`. If the edit removes the queue suffix, it shows `⬦ **username** removed message from queue`. The queue confirmation also tells users they can edit the message to update it.

4. **User input indicators for buttons, dropdowns, and file uploads** — action button clicks, question dropdown answers, and file uploads now show the `» **username:** action` prefix in Discord threads, matching the existing pattern for queued messages and agent commands.

5. **Fix `/model` and `/model-variant` not updating current session for global/channel scope** — selecting "global" or "channel" scope previously persisted the preference but the running session kept the old model until the next message. All three scopes now update the current session and restart the request with the new model.

6. **Fix bot becoming permanently unresponsive after gateway proxy outages** — `@discordjs/rest` calls `setToken(null)` on any 401 response. When the gateway proxy returned transient 401s, this killed the REST token permanently and every subsequent API call failed. The fix blocks null token values so the bot recovers automatically when the proxy comes back.

7. **Fix stale interrupt timers aborting unrelated generations** — the interrupt plugin now clears pending timers on errored assistant messages and on session idle events, preventing timers from surviving across turns and aborting later work.

8. **Worktree base branch discovery in system message** — the agent now gets instructions for finding its worktree starting point via `git merge-base` and `git symbolic-ref`, useful for diffs and merge decisions.

9. **Fix OpenCode server auth passthrough** — when `OPENCODE_SERVER_PASSWORD` is set (e.g. inherited from a parent OpenCode process), the SDK client now sends Basic auth headers so `session.promptAsync` and `event.subscribe` work correctly. Thanks @Dxee-e for #139!

10. **Prevent `@username` pings in scheduled task prompts** — scheduled task prompts become Discord thread titles, so raw `@username` triggered real pings on every task run. The system message now instructs the model to use Discord user ID mentions instead.

## 0.13.1

1. **Fix session interrupts being silently dropped** — sending a new message while the bot was mid-run (e.g. during a long tool call) often failed to abort and replay the queued message. Two root causes: the plugin's `ctx.client` didn't make REST calls reliably (now builds its own SDK client from `ctx.serverUrl`), and abort confirmation now polls session status instead of waiting on events that sometimes never arrived.

2. **Fix `/new-worktree` in existing threads forking to a separate thread** — running `/new-worktree` inside an active thread no longer switches the current thread in-place. The original thread keeps its session and checkout; a new thread gets the worktree, the forked session context, and the metadata for `/merge-worktree`.

3. **Fix OpenAI voice transcription** — voice messages configured with an OpenAI API key work again. The deprecated `gpt-4o-audio-preview` model is replaced with the current `gpt-audio` chat model.

4. **Fix kimaki shim aborting with `.env: not found`** — the relocatable shim at `~/.kimaki/bin/kimaki` no longer leaks `--env-file` flags from the bot's startup args. Running `kimaki` subcommands from directories without a `.env` file no longer crashes.

5. **Upgrade `@opencode-ai/sdk` and `@opencode-ai/plugin` to 1.15.11** — adapts to the newer SDK event types (top-level `id` field on every event) and centralizes error message extraction across SDK response shapes.

## 0.13.0

1. **New `--allow-mention` CLI flag** — control which Discord mention types the bot can trigger. Default is `users` only, which prevents the bot from pinging `@everyone`, `@here`, or roles. Repeatable flag to allow additional types:

   ```bash
   kimaki --allow-mention users --allow-mention roles
   ```

   Valid values: `users`, `roles`, `everyone`.

2. **Support editing queued messages via Discord message edits** — when a user edits a Discord message that is still waiting in kimaki's local queue (messages ending with `. queue`), the queue item is updated with the new content. If the edit removes the queue suffix, the item is removed from the queue entirely.

   ```
   User sends:    "fix the bug. queue"     → queued at position 1
   User edits to: "fix it properly. queue" → queue item updated
   User edits to: "fix it properly"        → item removed from queue
   ```

   Messages that were already dispatched to opencode (dequeued) are unaffected by edits.

3. **Change `btw` shortcut from prefix to suffix detection** — now only triggers when preceded by punctuation or a newline (e.g. `fix the bug. btw check tests`), matching the same pattern as the queue suffix. The text before `btw` continues in the current session while the btw prompt forks to a new thread.

4. **Make state-changing slash commands non-ephemeral** — `/upgrade-and-restart`, `/abort`, `/undo`, `/redo`, `/restart-opencode-server` replies are now fully visible to all users and trigger normal Discord notifications. Error replies remain ephemeral.

5. **Fix interrupt replay after abort** — kimaki now waits for OpenCode's post-abort idle event before replaying the interrupting user message, so the replay is not queued behind the cancelled run and its assistant response is visible in Discord. Fixes #133

6. **Fall back to default agent when requested agent not found** — if `kimaki send --agent foo` references an agent that doesn't exist in the project's opencode config, it logs a warning and uses the default agent instead of failing. Closes #136

7. **Use `caffeinate -s` for lid-close keep-awake** — the Mac stays awake even with the lid closed when on AC power. On battery, macOS still sleeps normally to preserve charge.

## 0.12.0

1. **New `--disable-sync` flag** — turn off background mirroring of external OpenCode sessions into Discord:

   ```bash
   kimaki --disable-sync
   ```

   When enabled (default), sessions started from the OpenCode CLI or TUI automatically appear as Discord threads in the matching project channel. Use `--disable-sync` if you only use Kimaki through Discord and don't need the mirroring. The background sync loop also now uses per-directory timeouts with proper cancellation, so one slow or unresponsive OpenCode server cannot block syncing for other projects.

2. **Opencode is no longer bundled** — Kimaki no longer downloads and pins a specific opencode version. It requires opencode to be installed globally. On startup, the bot checks PATH and prompts to install if missing via `curl -fsSL https://opencode.ai/install | bash`. This avoids version skew issues where an older bundled opencode ran alongside a newer global one. The `kimaki opencode` passthrough command has been removed accordingly.

3. **Discord embeds, polls, and forwarded messages are now visible to the AI** — previously, Discord embeds (link previews, rich embeds), polls, and forwarded message snapshots were invisible to the AI model. Now they are serialized as structured text and included in the message context. This also works for replied-to messages.

4. **State-changing slash commands are now visible to all users** — `/model`, `/model-variant`, `/agent`, `/verbosity`, `/toggle-worktrees`, `/toggle-mention-mode`, and `/unset-model` responses are no longer ephemeral. Everyone in the channel can see when someone changes the model or agent. Error-only early returns and credential-sensitive commands remain ephemeral.

5. **Fix quick agent commands with inline prompts** — using `/plan-agent <prompt>` now correctly starts or continues the session with the `plan` agent instead of only borrowing that agent's model while OpenCode still ran the previous agent.

6. **Harden Discord permission checks** — messages from uncached guild members now fetch the member before deciding access, autocomplete no longer exposes project metadata to unauthorized users, and live voice audio is ignored unless the speaker has Kimaki access.

7. **Fix model/provider select menu crashes** — select menus no longer crash when a model name or provider name is undefined or exceeds Discord's character limits.

## 0.11.0

1. **New `kimaki tts` command for text-to-speech audio generation** — generate speech audio from text using OpenAI (`gpt-4o-mini-tts`) or Google Gemini (`gemini-2.5-flash-preview-tts`). Provider is auto-detected from the API key prefix (`sk-*` = OpenAI, otherwise Gemini).

   ```bash
   # Generate audio file
   kimaki tts "Hello world" --voice alloy --output greeting.mp3

   # Generate and upload directly to a Discord thread
   kimaki tts "Build summary" --session ses_xxx
   ```

   API keys are resolved from the database (same keys set via `/transcription-key`), then falls back to `OPENAI_API_KEY` / `GEMINI_API_KEY` env vars.

2. **New `--allow-all-users` flag** — bypass role and permission checks so any Discord member can start sessions and use slash commands without needing the Kimaki role, Administrator, or Manage Server permissions. The `no-kimaki` role still blocks access even when this flag is enabled. Credential-sensitive commands (`/login`, `/transcription-key`) remain restricted to admins.

   ```bash
   kimaki --allow-all-users
   ```

3. **One-shot prompts on quick agent commands** — `/plan-agent`, `/build-agent`, and other quick agent commands now accept an optional `prompt` argument. When provided, the prompt is sent with that agent as a temporary override without changing the persistent agent preference:

   ```
   /plan-agent prompt: fix the login bug
   ```

   In a thread this enqueues on the existing session; in a channel it creates a new thread.

4. **Clear stale global Discord commands on startup** — Kimaki registers slash commands as guild commands so updates are immediate. Startup now also bulk-clears global commands for self-hosted bots, removing older commands that are no longer registered and preventing duplicate stale entries from staying visible in Discord.

5. **Truncated session error messages in Discord** — provider error payloads can include enormous response bodies. Kimaki now truncates error messages to 400 characters, keeping them concise while still showing the important prefix and provider status.

## 0.10.2

1. **Pinned opencode binary to v1.14.41** — Kimaki now downloads the opencode binary from GitHub releases on first run instead of relying on a globally installed binary. The binary is cached at `~/.kimaki/bin/opencode-{version}` and old versions are cleaned up automatically. The `OPENCODE_PATH` env var still works as an explicit override. This prevents new opencode releases from unexpectedly breaking Kimaki for all users.

2. **Fixed infinite event stream reconnect loop** — the bot no longer locks up when the opencode SSE endpoint closes the connection normally. The listener loop now uses exponential backoff (500ms up to 30s) before reconnecting, and backoff only resets after the stream delivers at least one event.

## 0.10.1

1. **Fixed event stream reliability** — reverted to per-directory event subscription, avoiding spurious events from other sessions leaking into the active thread.

## 0.10.0

1. **Auto-grant cross-project directory access via channel mentions** — mention a registered project channel like `#website` in your message and Kimaki automatically grants the active session access to that project's directory. Works on both thread-starting messages and follow-ups, so cross-project requests can inspect referenced folders without a manual `/add-dir` step first.

2. **New `kimaki session wait <sessionId>` command** — wait on an existing session without passing a project path. The command resolves sessions from the local database, blocks until OpenCode is idle (including through permission prompts), and prints the final session markdown to stdout.

3. **`kimaki send --cwd` supports project subfolders** — scheduled and immediate sends can now target a subdirectory of the channel project as the OpenCode working directory. This lets you keep a restricted `opencode.json` in a subfolder and run recurring tasks there:

   ```bash
   kimaki send --project /repo --cwd /repo/restricted-task --send-at '0 9 * * 1' --prompt 'Run the restricted task'
   ```

4. **Migrated local database from Prisma to Drizzle** — the CLI now uses Drizzle/libSQL for all local SQLite operations. Same on-disk database, same startup migration behavior, but Prisma is no longer bundled in the published package. This reduces install size and simplifies the database layer.

5. **Fixed startup healthcheck hangs** — Kimaki no longer gets stuck forever at `Waiting for OpenCode server...` when the server accepts the TCP connection but delays the HTTP response. Each healthcheck request now has a timeout and keeps polling. Fixes #123

6. **Fixed Hrana SQLite schema bootstrap** — fresh databases created through the local Hrana HTTP bridge now receive the same schema bootstrap as direct file connections, preventing `no such table: bot_tokens` errors on first startup.

7. **Fixed OpenCode 1.14 event stream handling** — adapted to OpenCode's global event subscription API so session events dispatch correctly. Thanks @ian-pascoe for #125.

8. **Improved session routing guidance** — agents are now told to use the current channel by default, only target another project channel or checkout path when the user explicitly asks, and only create worktrees when explicitly requested.

## 0.9.1

1. **Fixed worktree sessions for non-git-root project folders** — when worktrees are enabled but the configured project folder is not the git repository root, Kimaki now falls back to a normal session in that folder instead of creating a broken worktree record that makes every follow-up message reply with a worktree error. Fixes #112

2. **`kimaki tunnel` auto-detects port without `--port`** — when running `kimaki tunnel -- <dev server>`, Kimaki now waits for the dev server to print a localhost URL or port line and detects the port automatically. The `--port` flag is still available for servers that don't print a detectable port.

## 0.9.0

1. **Multi-provider OAuth account rotation** — Kimaki now manages OAuth account pools for both Anthropic and OpenAI. Accounts are rotated on rate-limit retries, and OpenAI tokens display extracted identity metadata when available:

   ```bash
   kimaki multioauth list
   kimaki multioauth anthropic list
   kimaki multioauth anthropic current
   kimaki multioauth openai list
   kimaki multioauth openai current
   kimaki multioauth openai check
   ```

2. **`kimaki send --user` works without Server Members Intent** — the `--user` flag now accepts raw Discord IDs and mentions directly, so servers that lack the privileged intent can still target users from the CLI:

   ```bash
   kimaki send --channel 123 --prompt 'Review this' --user '535922349652836367'
   kimaki send --channel 123 --prompt 'Review this' --user '<@535922349652836367>'
   ```

   Onboarding now only requires Message Content Intent. If member lookup fails, Kimaki shows fallback guidance instead of crashing.

3. **Respect manual Discord thread renames** — if you rename a thread after Kimaki created it, future OpenCode title syncs and bot restarts will preserve your custom name instead of overwriting it. Fixes #115

4. **Preserve Anthropic project instructions** — the system prompt sanitizer now only strips the OpenCode identity block, keeping project instructions, skill instructions, and agent context intact. Fixes #116

5. **Clearer `/merge-worktree` failures** — when the target worktree has uncommitted changes, the error now tells you to commit or clean the main worktree first instead of showing a generic git push failure.

6. **Fix voice agent selection** — casual mentions of agent names (like "ask the build agent what changed") no longer accidentally switch the active agent. Only clear command phrases at the start of a message trigger agent selection.

7. **Handle unreadable Discord messages** — when Message Content Intent is unavailable and Discord withholds text, Kimaki now tells the user to mention the bot instead of creating empty threads. Also points to `--mention-mode` for intentional setups.

8. **Removed personal-only skills from npm package** — shipped skills now exclude workflow-specific tools like `jitter`, `proxyman`, `x-articles` that belong in personal config.

9. **Quieter `kimaki project add`** — removed redundant pre-create log message during channel creation.

## 0.8.1

1. **Fixed Bun crash on startup** — `bunx --bun kimaki@latest` crashed with `TypeError: null is not an object (evaluating 'body.pid')` during Hrana server startup because Bun's `response.json()` can return `null` instead of throwing. Added null guards across all fetch `.json()` call sites.

## 0.8.0

1. **New `/last-sessions` command** — list the 20 most recently active sessions across all projects, sorted by last activity. Shows a table with clickable thread links and project names:

   ```text
   /last-sessions
   ```

2. **Model and agent banner on new sessions** — when a new session thread is created, Kimaki now sends a silent status message showing the active model and agent (e.g. "using anthropic/claude-sonnet-4 · build"), so you always know which model is handling your request.

3. **`/add-dir` now applies to busy sessions immediately** — previously the permission update only took effect on the next turn. Now Kimaki aborts and restarts any active run in the affected session so OpenCode picks up the new permissions right away. Idle sessions are left untouched.

4. **Resume idle sessions after permission replies** — permission accepts that arrive after OpenCode has already gone idle (e.g. from auto-rejected or interrupted runs) now resume the session automatically. Expired permission prompts also update their Discord message to explain the expiry.

5. **CLI JSON output is pipe-safe** — logger diagnostics are now routed to stderr so subcommands like `kimaki project list --json` can safely pipe stdout to `jq` without noise.

6. **Fix: resolved model now passed correctly to opencode user commands** — custom opencode commands receive the correct model override instead of the default.

## 0.7.1

1. **Fix: Claude subagent sessions (Task tool) now work correctly** — the Anthropic auth plugin now handles the subagent prompt structure. Subagent sessions spawned via the Task tool use a different system prompt format ("You are powered by the model named…" + `<env>` block) instead of the main-session `OPENCODE_IDENTITY` marker. The plugin now strips both patterns correctly, so Claude API calls from subagents no longer fail with malformed/oversized system prompts.

2. **Fix: working directory extraction from updated OpenCode system prompt format** — OpenCode changed its environment block from `<environment><cwd>/path</cwd></environment>` to `<env>\nWorking directory: /path\n</env>`. The plugin now reads the new `Working directory:` format first and falls back to the old `<cwd>` tag for backwards compatibility. Fixes incorrect per-session directory in multi-session and worktree setups.

3. **Fix: callout blocks now render as colored containers** — `<callout>` tags were getting the `⬥` text prefix because `<` was not in the markdown starters list. The prefix is now skipped for callout tags so the Discord Components V2 parser sees them correctly and renders them as accent-colored containers.

## 0.7.0

1. **New `/fork-subagent` command** — fork an active subagent task session into its own Discord thread. Shows a dropdown of running subagent tasks with their prompt previews. The new thread inherits the full session context (memory, tool outputs, event history) so you can continue the subagent's work independently:

   ```text
   /fork-subagent
   ```

2. **Callout containers in Discord** — the bot now renders accent-colored callout blocks (warnings, tips, action-required notes) as Discord Components V2 containers. Callouts can recursively include tables and action buttons, making structured responses easier to scan. The system prompt includes color-coded callout types: orange for warnings, blue for TODOs, red for tool failures, purple for gist summaries.

3. **`/add-dir` directory option now optional** — omit the directory argument to default to `*` (all directories) for the current session. Explicit paths are still resolved against the active worktree when provided:

   ```text
   # Allow all directories (no argument needed)
   /add-dir

   # Allow a specific directory (still works)
   /add-dir ../shared-data
   ```

4. **Fix: Anthropic plugin per-session directory resolution** — the Anthropic auth plugin now extracts the per-session working directory from the OpenCode identity block instead of using the server's cwd. Fixes incorrect file paths in multi-session and worktree setups.

5. **Fix: faster startup when replacing a running instance** — the Hrana database server now polls the old process every second during eviction instead of sleeping a fixed 6 seconds. Startup is faster when the old instance shuts down promptly while still allowing graceful cleanup.

## 0.6.0

1. **Subagent rate-limit handling** — when a task-created child session hits a provider rate limit (HTTP 429), kimaki now automatically aborts the subagent session instead of letting the error cascade to the parent. The parent task session recovers on its own, keeping rate-limit noise out of your Discord threads.

2. **Bash tool for the voice assistant** — the GenAI worker now includes a shell execution tool that can run commands in the project directory. It also supports remote skill loading: skill SKILL.md files fetched from URLs are cached locally and their metadata is injected into the tool description so the model can discover specialized workflows.

3. **Common toolchain caches pre-allowed** — zig, cargo, go build, and go pkg cache directories under `~` are now pre-allowed as external directories. Agents using these toolchains no longer trigger permission prompts for inspecting downloaded modules and build artifacts.

4. **Fixed infinite abort-replay loop on large contexts** — when the LLM took >3 seconds to return the first token (e.g. 239K token prompts), the interrupt plugin would abort and replay the message in a tight loop every 3 seconds. Replayed message IDs are now tracked to break the cycle.

5. **Fixed unscoped Discord toasts** — global plugin toasts without a session-scoped marker were being forwarded into unrelated Discord threads. Toasts are now only rendered when they carry a session ID, preventing rate-limit and status toasts from spamming conversations.

6. **Fixed Anthropic OAuth identity in system prompt** — the Anthropic auth plugin now correctly rebrands the openc0de identity and allows `~/.config/openc0de` as a valid config directory, fixing repeated auth failures.

7. **Fixed home directory resolution bug** — corrected path resolution for the user's home directory in opencode startup.

## 0.5.0

1. **New `/add-dir` Discord command** — expand the current session's directory access permissions without restarting. In a thread with an active session, run `/add-dir <path>` to grant the AI access to a specific external directory, or `/add-dir *` to allow all directories:
   ```text
   /add-dir ../other-project
   /add-dir /tmp/shared-data
   /add-dir *
   ```

2. **Worktree sessions can no longer edit the main checkout** — when a thread moves into a git worktree, existing and newly created sessions automatically deny write access to the original repo path. This prevents the agent from accidentally modifying the main branch while working in a worktree.

3. **System prompt drift notices show inline diff snippets** — the "Context cache discarded" toast now includes a short markdown diff snippet directly in Discord, instead of writing a debug file to disk. Makes it immediately visible which parts of the system prompt changed.

4. **`kimaki tunnel` now injects `TRAFORO_URL` into the child process** — apps launched through `kimaki tunnel` can read `process.env.TRAFORO_URL` to wire OAuth callbacks, webhook URLs, and absolute links to the public tunnel instead of localhost:
   ```bash
   kimaki tunnel -- sh -c 'BETTER_AUTH_URL=$TRAFORO_URL exec pnpm dev'
   ```

5. **Fixed OpenCode directory resolution for worktree sessions** — agent, model, provider, and config calls now pass the worktree-aware directory instead of the client default, so worktree sessions resolve against the active checkout correctly.

6. **Fixed OpenCode log chunking** — stderr/stdout from the opencode server process is now read line-by-line instead of splitting raw chunks, preventing garbled or merged log lines.

## 0.4.104

1. **Queued messages now keep moving while question dropdowns are open** — if the assistant asks a dropdown question and you queue a follow-up message, kimaki now hands off the first queued item immediately instead of waiting for the dropdown to be answered. This keeps the visible `» user:` dispatch indicator moving and prevents queued work from feeling stuck behind interactive prompts.

## 0.4.103

1. **`btw` message shortcut for side-question forks** — type `btw fix the auth bug` directly in a thread to fork the session with full context, without using the `/btw` slash command. Supports punctuation separators like `btw. check this`, `btw, why is this broken`, `btw: look at that`. Thread titles preserve the `btw:` and `Fork:` prefixes when OpenCode renames them.

2. **`--enable-skill` / `--disable-skill` flags** — control which bundled skills get injected into the model's system prompt:
   ```bash
   # only load specific skills
   kimaki --enable-skill drizzle --enable-skill errore

   # hide noisy skills
   kimaki --disable-skill jitter --disable-skill termcast
   ```
   Flags are mutually exclusive (whitelist vs blacklist) and repeatable.

3. **`/worktrees` now shows all worktrees, not just kimaki-created ones** — uses `git worktree list` as source of truth, enriched with DB metadata (thread links, timestamps). Surfaces kimaki-created, opencode-created, and manually created worktrees in a single table with a Source column.

4. **Shorter worktree folder names** — worktrees now live under `<dataDir>/worktrees/<hash>/<basename>` instead of the deeply nested opencode paths with `opencode-kimaki-` prefix. Shorter paths make the agent less likely to accidentally operate on the wrong worktree.

5. **`kimaki anthropic current-account`** — prints the currently active Anthropic OAuth account email for quick inspection.

6. **Fixed Anthropic system prompt losing working directory** — `sanitizeAnthropicSystemText` was stripping the OpenCode identity block which contains environment context (cwd, OS). The model now retains awareness of the current working directory after the Anthropic rewrite.

7. **Fixed duplicate question dropdowns** — repeated `AskUserQuestion` tool requests no longer produce duplicate Discord select menus. Stale contexts are cleaned up on answer, cancel, or expiry.

8. **Fixed queue drain dumping all messages at once** — answering a dropdown question no longer flushes every locally queued message into OpenCode simultaneously. Only the next queued message is dispatched, preserving normal one-by-one Discord indicators.

9. **Fixed duplicate task start messages** — repeated tool updates for the same part no longer post the same Discord line twice.

10. **Skills from `~/.config/opencode/skills/` now load correctly** — fixed path resolution for user-installed skills outside the bundled skills directory.

## 0.4.102

1. **Fixed OpenCode plugin failing to load in the published npm package** — kimaki now loads `dist/kimaki-opencode-plugin.js` in published builds instead of the TypeScript source entrypoint, which imported `.js` sibling files that don't exist under `src/` in the npm tarball. Users running kimaki under PM2 or npx saw `ERR_MODULE_NOT_FOUND: Cannot find module 'ipc-tools-plugin.js'` on startup; this is now fixed.

2. **`~/.opensrc` is now pre-allowed in OpenCode permissions** — agents can inspect cached opensrc package checkouts without triggering interactive permission prompts.

## 0.4.101

1. **Claude Max login works again when Anthropic shows the new third-party app billing prompt** — kimaki now rewrites Anthropic's transformed system prompt in the hook Anthropic actually reads, so OAuth login keeps working when Claude shows messages like "Third-party apps now draw from your extra usage" instead of silently falling back to a broken prompt state.

2. **`MEMORY.md` heading overview is now frozen per session** — kimaki snapshots the condensed `MEMORY.md` table of contents on the first real user message and reuses that same overview for the rest of the session. Editing `MEMORY.md` mid-session no longer mutates the active system prompt or invalidates the session cache; starting a new session still picks up the latest headings.

3. **`/login` now surfaces `opencode` and `opencode-go` providers** — the provider picker prioritizes both entries so they are easier to find when signing in through Discord:
   ```text
   /login
   ```

## 0.4.100

1. **`/vscode` now opens reliably through the Kimaki tunnel** — the browser editor no longer depends on Coderaft's `?tkn=` connection-token redirect flow, which could fail and return `Forbidden` after passing through the public tunnel. Kimaki now launches Coderaft without a connection token and returns the unique tunnel URL directly:
   ```text
   /vscode
   ```
   The session still auto-stops after 30 minutes, and the generated tunnel host remains high-entropy and hard to guess.

## 0.4.99

1. **Existing gateway installs now auto-migrate to `kimaki.dev`** — on startup, kimaki rewrites saved gateway proxy URLs from `discord-gateway.kimaki.xyz` to `discord-gateway.kimaki.dev` in local SQLite for gateway mode. This prevents legacy endpoint drift that could cause Discord interactions to time out with "application did not respond".

## 0.4.98

1. **New `/vscode` Discord command** — open the current project or worktree in browser VS Code (Coderaft) through a private tunnel, with automatic 30-minute shutdown. This is useful for quick remote edits without leaving Discord:
   ```text
   /vscode
   ```

2. **`kimaki.dev` is now the default domain for new sessions and links** — default onboarding website URL, gateway proxy URL, and tunnel-based features now point to `kimaki.dev`. Existing `kimaki.xyz` routes remain supported during migration.

3. **System prompt drift notices are less noisy** — drift detection now waits until system-transform hooks finish mutating the prompt before comparing turns, reducing false positives in "Context cache discarded" toasts.

## 0.4.97

1. **Anthropic account CLI commands are now visible in help** — `kimaki anthropic account list/add/remove` commands appear in normal `--help` output. `remove` now accepts either a 1-based index or a stored email address for easier cleanup.

2. **Anthropic account identity persisted across OAuth rotation** — kimaki fetches your Anthropic profile email and account IDs during login and stores them alongside credentials. Account records are deduplicated by stable identity so rotating tokens doesn't create phantom duplicate entries.

3. **Anthropic plugin toasts scoped to the active session** — account-switch and rewrite warnings now appear only in the Discord thread that triggered the event instead of broadcasting to all threads.

4. **Worktrees now branch from current HEAD** — new worktrees start from whatever your local checkout is at, including commits that haven't been pushed yet. Previously, only the remote `origin/HEAD` was used as the base.

## 0.4.96

1. **System prompt drift toasts now route to the correct Discord thread** — toasts from the `systemPromptDriftPlugin` are now scoped to the active session's thread. A hidden session marker is appended in the plugin and stripped before rendering, so drift notices appear only in the thread that triggered the event instead of broadcasting globally.

2. **Simpler debug filenames for system prompt drift** — saved system prompt and diff files now share a timestamped basename (e.g. `2026-04-08T10-01.md` / `2026-04-08T10-01.diff`) instead of using the session ID, keeping the debug paths shorter and each event self-contained.

3. **Cleaner drift toast copy** — diff and latest-prompt paths are now shown as inline code; wording is lower-cased and the extra explanatory sentence is removed to keep the notice concise.

## 0.4.95

1. **Fixed Claude Max subscription prompt stripping** — instead of replacing the entire system prompt or splicing out the whole OpenCode identity block, kimaki now removes only the section from `"You are OpenCode…"` up to `"# Code References"`, preserving the rest of the prompt that Anthropic's API expects. This restores correct behaviour for Claude Pro/Max OAuth users. Shows a toast error if the expected marker is not found.

2. **Fixed discord.js CJS interop in plugin chain** — the plugin loader now uses a namespace import for discord.js to avoid CJS/ESM interop crashes when running inside the OpenCode plugin host process.

## 0.4.94

1. **Fixed Claude Max subscription support** — the error message "Third-party apps now draw from your extra usage, not your plan limits" no longer breaks authentication. Kimaki now correctly detects active Max subscriptions and continues using them without requiring a re-login.

2. **New `systemPromptDriftPlugin`** — detects when the effective system prompt changes between turns inside an OpenCode session. When drift is detected, it writes a unified diff to the Kimaki data directory and shows a Discord toast with addition/deletion counts, making it easy to spot which plugin is busting the prompt cache and driving up rate-limit usage.

3. **Log output is now capped at 1 000 characters per argument** — prevents runaway log files when tools return very large outputs. Truncated portions show a `… [truncated N chars]` suffix so nothing is silently dropped.

4. **Softer wording on worktree directory reminders** — the mid-session reminder injected when switching to a worktree now says "You should read, write, and edit files under …" instead of "You MUST …", reducing unnecessary alarm in the agent's context.

## 0.4.93

1. **Claude account rotation is now visible in Discord** — when Anthropic OAuth hits a rate limit or auth failure and kimaki rotates to another saved Claude account, the thread now shows a toast-style notice with the account labels so you can see which account it switched from and to.

2. **`/merge-worktree` conflict recovery now preserves both sides more reliably** — when a rebase conflict happens during merge, the follow-up AI instructions now explicitly walk through reading the merge base, both sides' commit history, and both diffs before editing conflicted files. This reduces the chance of the model dropping a fix or feature while resolving conflicts.

3. **Agent-switch replies now say when the change applies** — thread-scoped `/agent` and quick `/<agent>-agent` commands now tell you the new agent takes effect on the next message, instead of implying the running turn changed immediately.

4. **Footer keeps more of long folder and branch names** — kimaki now truncates footer folder and branch labels at 30 characters instead of 15, so project info stays readable without overflowing Discord.

## 0.4.92

1. **Fixed `/command-cmd` prompts being sent to the model when the bot starts up** — when using `kimaki send --prompt '/hello-test-cmd'` (or any `/commandname-cmd` prompt), the command was routed as plain text to the model instead of being executed via `session.command`. This happened because the registered commands list is empty during the gateway startup race (before `backgroundInit` completes). The detector now falls back to suffix-stripping (`-cmd`, `-skill`, `-mcp-prompt`) when the list is empty, so commands are correctly routed regardless of startup timing. Fixes [#97](https://github.com/remorses/kimaki/issues/97).

2. **Footer truncates long folder and branch names** — project directory names and branch names longer than 15 characters are now capped with a `…` suffix so the footer line stays compact in Discord.

3. **Subagent sessions excluded from external sync** — helper task sessions (whose title ends with `subagent)`) no longer create or update mirrored Discord threads in external sync, reducing noise.

## 0.4.91

1. **New `--cwd` flag for `kimaki send`** — start a session using an existing git worktree directory instead of the main project directory:
   ```bash
   kimaki send --channel <id> --prompt 'task' --cwd /path/to/worktree
   kimaki send --channel <id> --prompt 'task' --cwd /path/to/worktree --send-at '2026-04-07T09:00:00Z'
   ```
   The path is validated against `git worktree list` to ensure it belongs to the project. If `--cwd` points to the main project directory it is silently ignored.

2. **Discord reply context in prompts** — when you reply to a Discord message in a session thread, the agent now sees what message you replied to as part of the turn context. Useful for referencing earlier responses without quoting them manually.

3. **Fixed queued prompts being dropped after an interrupted session** — when OpenCode aborted a running turn (e.g. a long tool call), follow-up messages queued via `/queue` or the bot's queue mechanism were silently discarded or sent to the wrong model. The interrupt plugin now replays the original queued message with its full prompt parts, agent, and model context after abort.

4. **Fixed external sync session discovery** — the external sync poller reverted to per-directory session listing which reliably finds active sessions. The previous global endpoint caused sync to miss sessions and show stale state in linked channels.

5. **Fixed OpenCode plugin compatibility with recent OpenCode releases** — resolved plugin startup failures caused by clack logger imports and plugin logging isolation issues that broke after upstream OpenCode changes.

6. **OpenCode server warnings and errors now appear in kimaki logs** — opencode server log output at warning level and above is forwarded to `~/.kimaki/kimaki.log`, making it easier to debug server-side issues without checking separate log files.

7. **Removed automatic Kimaki Discord role management** — the bot no longer auto-creates or repositions a "Kimaki" role in your server on startup. Role management is left to server admins.

## 0.4.90

1. **Fixed `/btw` forked sessions continuing the parent task** — the forked thread now only answers the side question and does not resume or reference whatever the original session was working on. The prompt is wrapped with explicit framing so the model stays focused on the question.

2. **Fixed `external_directory` permission defaults being overridden** — kimaki was injecting a catch-all `'*': 'ask'` rule that silently overrode whatever you set in your project's `opencode.json`. The wildcard is now removed; only the specific directory allowlists (tmpdir, `~/.config/opencode`, `~/.kimaki`, project dir, worktree origin) are kept. Fixes [#90](https://github.com/remorses/kimaki/issues/90) and [#92](https://github.com/remorses/kimaki/issues/92).

3. **`kimaki project create` now respects `--projects-dir`** — the root command already accepted `--projects-dir` but the `project create` subcommand didn't, so running it standalone always used the default path. Now `kimaki project create my-app --projects-dir /custom/path` works as expected.

4. **Added CI workflow for integration tests** — automated test runs on every push to catch regressions early.

## 0.4.89

1. **New `--injection-guard` flag for `kimaki send`** — enable prompt-injection scanning only for the session you are starting, without turning it on globally for the whole project:
   ```bash
   kimaki send --prompt 'Review this repo safely' --injection-guard 'bash:*'
   kimaki send --thread <thread-id> --prompt 'Continue with web checks' --injection-guard 'webfetch:*'
   ```
   Patterns use the form `tool:argsGlob`, and you can repeat the flag multiple times to scan several tool families in one session.

2. **Fixed scheduled sends to existing sessions** — `kimaki send --session ... --send-at ...` now reliably wakes the target thread instead of posting a message that leaves the session idle.

3. **Fixed dynamic command threads losing their arguments** — when a slash command like `/<name>-cmd`, `/<name>-skill`, or `/<name>-mcp-prompt` starts a new thread, the starter message and thread title now include the full command invocation instead of dropping the arguments.

4. **Fixed worktree folder-switch reminders** — when a session moves into a new worktree, kimaki now reminds the model about the exact previous folder it must stop editing, reducing accidental reads or writes in the old directory.

## 0.4.88

1. **Built-in prompt injection guard** — kimaki now ships with `opencode-injection-guard`. Opt-in: create `.opencode/injection-guard.json` (even an empty `{}`) in your project to activate it. A fast LLM judge inspects tool call outputs before they reach the main agent, blocking injected instructions from hijacking your coding sessions.

2. **Fixed project-level `opencode.json` permissions being ignored** — kimaki's default permissions (like `external_directory: ask`) were overriding your project's `opencode.json` settings because they were injected via `OPENCODE_CONFIG_CONTENT` which loads last in opencode's config chain. Kimaki now writes its config to `~/.kimaki/opencode-config.json` and uses `OPENCODE_CONFIG` (file path), which loads before project config — so your project-level permission settings are correctly respected. Fixes [#90](https://github.com/remorses/kimaki/issues/90).

3. **Fixed `kimaki send` thread creation race causing DiscordAPIError[160004]** — `kimaki send` posts a starter message then creates the thread via REST. A recent change accidentally caused the bot's GuildText handler to also try calling `startThread()` on the same message, triggering a "thread already created" error. The GuildText handler now skips messages with a start marker.

4. **Updated OpenCode SDK to 1.3.7** — picks up latest OpenCode improvements.

## 0.4.87

1. **New `/btw` command** — fork the current session into a new thread and immediately send a prompt, without replaying past messages:
   ```
   /btw prompt: why is the auth module structured this way?
   ```
   Useful for side questions or tangents without polluting or blocking the original thread. The forked thread inherits the full session context and starts working right away.

2. **Fixed slash command registration exceeding Discord's 100-command limit** — with many agents, skills, and MCP prompts, the total could exceed Discord's hard cap and cause registration errors. Dynamic commands are now registered in priority order (agents → user commands → skills → MCP prompts) and trimmed at 100. Three rarely-used static commands were removed to free slots: `stop` (duplicate of `/abort`), `memory-snapshot` (use `kill -SIGUSR1` instead), and `toggle-mention-mode`.

## 0.4.86

1. **Fixed voice messages getting lost when a question dropdown is pending** — sending a voice message while the AI's question dropdown is showing no longer discards the voice content. Previously, `message.content` (empty for voice) was passed as the question answer, sending `""` to the model, and the early-return prevented transcription from ever running. Now the empty-content message properly unblocks OpenCode's question waiter and flows through normal transcription, arriving as the next user message after the model responds.

## 0.4.85

1. **Fixed infinite reconnect loop after gateway proxy restart** — after a failed RESUME, the proxy now sends an `INVALID_SESSION` payload and properly drains the WebSocket sink before teardown, so the client reconnects cleanly instead of looping indefinitely.

2. **Fixed `ClientReady` errors crashing the bot silently** — unhandled rejections thrown inside the `ClientReady` handler are now caught and logged instead of taking down the process.

3. **Fixed slash commands being mirrored by external sync** — slash commands like `/errore-skill` dispatched from Discord were missing the `<discord-user />` origin tag (because `session.command()` doesn't accept synthetic text parts), causing external sync to treat them as external messages and mirror them as `» user: …`. The tag is now appended to command arguments so origin detection works correctly.

4. **Fixed Discord origin detection in command-argument text** — the origin metadata parser previously only matched the tag when it was the entire string (anchored `^…$`) and only looked in synthetic text parts. It now matches the tag anywhere in text and checks all text parts (synthetic first, non-synthetic as fallback).

## 0.4.84

1. **New `--projects-dir` flag** — set a custom directory where new projects are created:
   ```bash
   kimaki --projects-dir ~/my-projects
   ```
   Defaults to `<data-dir>/projects` if not set. The directory is created automatically if it doesn't exist.

2. **`kimaki tunnel --kill` flag** — kill any existing process on the port before starting the tunnel:
   ```bash
   kimaki tunnel --kill
   kimaki tunnel -k
   ```
   All tunnel usage examples in the system message and onboarding tutorial now include `--kill` so agents always free stale ports automatically.

3. **Screenshare links are now private by default** — `/screenshare` replies ephemerally, the default lifetime is 30 minutes, and tunnel IDs use 128-bit random values so leaked hosts are much harder to guess.

4. **Fixed queued messages getting stuck after question dropdown answered** — when a user answered a pending question via the Discord select menu, queued messages could stay stranded indefinitely. Queued items are now handed off to OpenCode immediately after the question reply instead of waiting for a separate idle event.

5. **Fixed external sync treating kimaki-initiated sessions as external** — the external sync poller was mirroring sessions owned by kimaki itself, creating duplicate `Sync:` threads. Detection now uses a pure event-based check (presence of `<discord-user />` in the latest user message) instead of a DB lookup, so it's accurate even when the DB entry hasn't been written yet.

6. **Fixed external sync missing Discord origin when message-id is absent** — bot-initiated threads weren't passing `sourceMessageId` to the ingress path, causing the origin parser to return null and mistakenly mirror those turns as `» user: hi`. Both the parser and the ingress call are now fixed.

7. **Fixed gateway reconnection crashes** — the forced gateway relogin mechanism was interfering with discord.js's own exponential-backoff reconnect logic, causing uncaught exceptions on handshake timeouts that killed the process. discord.js reconnection now handles recovery on its own.

## 0.4.83

1. **External OpenCode session sync** — kimaki now mirrors OpenCode sessions started outside Discord (e.g. from the CLI or another editor) into tracked Discord project threads automatically. Sessions are polled every 5 seconds, a new thread is created prefixed with `Sync:`, and messages stream in just like a normal kimaki session. Typing indicators show while the external session is busy.

2. **Two-way external sync** — replies sent in the synced Discord thread are forwarded back into the external OpenCode session. If you switch back to the CLI to continue a conversation, kimaki detects the new CLI-originated messages and re-claims the thread so sync keeps flowing.

3. **Live voice sessions switched to Gemini 2.0 Flash Live** — Discord voice sessions now use Google's latest lower-latency live audio model for faster, more natural conversations.

4. **Fixed scheduled thread prompts not triggering** — tasks scheduled against an existing thread were posted as bot messages that the bot's own-message guard was silently ignoring. Scheduled tasks now use the canonical start-marker path so they fire correctly.

5. **Fixed abort race before next message** — when a user sent a new message while a permission prompt was pending, the abort was fire-and-forget and the new message could race with the dying run. The abort now waits for `session.idle` (up to 2s) before the next message is enqueued.

6. **Suppressed notifications for intermediate queue steps** — permission prompts, question dropdowns, and footer messages now send silently when the thread queue has pending items. Only the final message in a queue notifies the user.

7. **SQLite cleanup on channel deletion** — deleting a Discord channel now removes all orphan rows (`channel_directories` and children) from the local SQLite database. `kimaki project list` no longer shows ghost entries, and a new `--prune` flag removes any remaining stale entries.

8. **Fixed OpenCode server restart on bot shutdown** — SIGINT was not suppressing the auto-restart loop, causing orphan OpenCode server processes to spawn after the bot exited. Both SIGINT and the `shuttingDown` flag now correctly suppress restarts.

## 0.4.82

1. **`/restart-opencode-server` now re-registers slash commands** — after restarting the OpenCode server, kimaki immediately re-registers all Discord slash commands (built-in + user commands + agents). New or changed commands, agents, and plugins are picked up without a full bot restart.
2. **Buttons and dropdowns stay alive for 24 hours** — permission prompts, question dropdowns, and file upload dialogs previously expired after 5 minutes (IPC stale TTL) and thread runtimes were disposed after 1 hour. Both are now 24 hours, so users who return the next day can still click pending buttons and selects.

## 0.4.81

1. **Fixed bot ignoring worktree and bot-created threads** — threads created by `/new-worktree`, `/fork`, or `kimaki send` were silently ignored because the thread guard (GitHub #84) checked for a non-empty session ID in the DB, but `createPendingWorktree` writes an empty `session_id`. The bot now also checks `thread.ownerId` — if the bot created the thread, it always responds.
2. **New `/memory-snapshot` command** — write a V8 heap snapshot to disk on demand for debugging memory issues. The snapshot is saved to `~/.kimaki/heap-snapshots/`.
3. **Fixed Anthropic OAuth token exchange race** — moved OAuth token exchange and refresh to an isolated Node helper to avoid 429 rate-limit responses and duplicate token exchanges when the browser callback lands.
4. **Fixed OOM from unbounded `session.diff` event strings** — `session.diff` events carrying large patch payloads are now dropped from the event buffer, and all buffered event strings are recursively pruned to a safe max length.

## 0.4.80

1. **Built-in Anthropic OAuth authentication** — the Anthropic OAuth plugin now ships with kimaki and loads automatically. No need to manage a separate plugin file in `~/.config/opencode/plugins/`. Log in with `/login` → Anthropic → OAuth and kimaki handles the PKCE flow, token refresh, and Claude Code request rewriting.

2. **New `kimaki task edit` CLI command** — edit the prompt and/or schedule of a planned task without deleting and recreating it:
   ```bash
   kimaki task edit <id> --prompt "Updated task description"
   kimaki task edit <id> --send-at "tomorrow at 9am"
   kimaki task edit <id> --prompt "New prompt" --send-at "every day at 8am"
   ```
   Only works on tasks in `planned` state.

3. **New `kimaki session discord-url` CLI command** — print the Discord thread URL for a given OpenCode session ID:
   ```bash
   kimaki session discord-url <session-id>
   kimaki session discord-url <session-id> --json
   ```
   `--json` returns `{ url, threadId, guildId, sessionId, threadName }` for scripting.

4. **Paginated select menus for `/model` and `/login`** — Discord caps select menus at 25 options, silently dropping anything beyond that. Providers like OpenRouter expose 162+ models, making many unreachable. Select menus now paginate with "← Previous page" / "Next page →" navigation so all providers and models are accessible.

5. **Fixed `/redo` to step forward one message at a time** — previously `/redo` jumped all the way back to the latest state in one shot. It now matches OpenCode TUI behavior: each `/redo` moves one user message forward (symmetric with `/undo`), so 3 undos require 3 redos to fully restore.

6. **Fixed OOM crash during long sessions** — assistant `message.updated` events were passing through the event buffer uncompacted, each carrying the full cumulative parts array (all tool outputs and text). With 1000 buffer entries, memory could exceed 4GB and trigger a V8 OOM kill. The buffer now strips `parts`, `system`, `summary`, and `tools` from all message events, keeping only the lightweight metadata needed for derivation.

7. **Fixed voice attachment detection and empty prompt guard** — improved detection handles cases where Discord omits `contentType` on uploaded audio files (checks duration, waveform, and file extension as fallbacks). Added a guard to skip sending empty prompts when voice transcription fails or produces no text.

8. **Fixed prompt.md wrapping in Discord file preview** — long-line prompts sent as file attachments are now word-wrapped at 120 chars before upload, so Discord's file viewer renders them readably instead of requiring horizontal scrolling.

9. **Fixed `/undo` and `/redo` error handling** — SDK errors on `session.get` and `session.messages` calls now bail early with the error message instead of silently proceeding with wrong behavior.

## 0.4.79

1. **New `/tasks` command** — list and cancel scheduled tasks created with `kimaki send --send-at`:
   ```
   /tasks        — show active scheduled tasks with Cancel buttons
   /tasks --all  — include completed and failed tasks
   ```
   Each row shows the task's schedule, next run time, status, and a Cancel button for active tasks.

2. **New `--permission` flag for `kimaki send`** — restrict which tools an OpenCode session can use on a per-send basis:
   ```bash
   kimaki send 'Fix the bug' --permission 'bash:deny'
   kimaki send 'Review only' --permission 'edit:deny' --permission 'write:deny'
   kimaki send 'Run tests'   --permission 'bash:git *:allow'
   ```
   Format is `tool:action` or `tool:pattern:action`. Rules are appended after base permissions so they take priority.

3. **Fixed `/undo`** — now correctly aligns with OpenCode's TUI behavior. Passes the last user message ID (not the assistant message ID) to `session.revert()`, and removes manual message deletion — cleanup happens automatically on the next prompt.

4. **Fixed error replies now trigger Discord notifications** — error messages from failed sessions, permission denials, and voice errors were using silent flags and easy to miss. They now send proper Discord notifications.

5. **Fixed bot responding to non-kimaki threads** — the bot was processing all threads in configured project channels, including user-created threads with nothing to do with kimaki. It now ignores threads that don't have an existing session unless explicitly @mentioned.

6. **Fixed `/login` code-mode OAuth** — when a provider returns `method="code"` (e.g. SSH-based flows), a "Paste authorization code" button now appears so users can complete the flow. Previously the context was deleted immediately, making code mode a dead end.

7. **Fixed queue messages not dispatching when action buttons are shown** — queued messages now dispatch immediately when the session becomes idle, even if action buttons are still visible. Previously the queue was blocked unnecessarily while buttons were on screen.

8. **Fixed cron task timezone** — cron schedules (e.g. `0 10 * * *`) are now always evaluated in UTC, matching what the system message tells the model. Previously they fired at the machine's local time, which was wrong when the server is in a different timezone.

9. **Startup time ~40% faster** — three optimizations reduce time-to-ready: OpenCode health poll interval dropped from 1000ms to 100ms, the OpenCode server now starts earlier (overlapping with Discord login), and `which opencode` / `which bun` checks run in parallel.

10. **Fixed `/login` error messages and stale context cleanup** — consistent error parsing across all login steps, and pending login contexts are now cleaned up on failure instead of lingering until TTL.

## 0.4.78

1. **New `/screenshare` command** — share your screen via noVNC directly in the browser. Works on macOS (uses built-in Remote Management) and Linux (spawns x11vnc):
   ```
   /screenshare        — start screen sharing, bot replies with a noVNC URL
   /screenshare-stop   — stop the active session
   ```
   Also available as `kimaki screenshare` from the CLI (runs until Ctrl+C). Sessions auto-stop after 1 hour. One active session allowed per guild. The in-process websockify bridge replaces the Python websockify dependency — no extra installs needed.

2. **Fixed plugin part IDs failing OpenCode validation** — OpenCode requires all part IDs to start with `prt_`. The plugin hooks (MEMORY.md injection, time-gap notice, memory save reminder, git branch injection, onboarding tutorial) were generating bare UUIDs, causing a ZodError at runtime. All five are now correctly prefixed.

3. **Fixed screenshare tunnel not cleaning up on connect failure** — if the tunnel failed to connect or timed out, the `TunnelClient` kept trying to reconnect in the background. It is now explicitly closed on error so no orphaned reconnect loops are left running.

4. **Fixed screenshare startup on Linux** — replaced a blind 1-second sleep after spawning x11vnc with a port-readiness poll (100ms interval, 3s max). The startup now fails immediately if x11vnc exits early instead of hanging.

## 0.4.77

1. **Fixed session hang after dismissing permission prompts** — when a user sent a new message while a permission prompt was blocking a previous run, the blocked run would hang indefinitely. Now pending permission requests are rejected immediately when a new message arrives, so the follow-up can proceed without waiting.

2. **`kimaki` available as a direct command inside OpenCode sessions** — agents can now call `kimaki` directly (without `npx` or `bunx`) inside OpenCode sessions. A small cross-platform shim is injected into the server PATH so `kimaki session archive`, `kimaki user list`, etc. work the same way regardless of whether kimaki was launched via a global install, npm, pnpm, or a transient npx/bunx invocation.

3. **Fixed selected model lost after interrupt/resume** — when a session was interrupted mid-run (e.g. via `/model` switch) and then resumed, the resumed run fell back to the default model instead of the user's selection. The interrupt plugin now captures and carries the chosen agent/model into the resume call.

4. **Fixed Windows opencode startup** — `where opencode` output is now normalized before picking a binary so Windows installs prefer npm shim paths over raw non-executable entries or multiline `OPENCODE_PATH` values. `.cmd` launches are routed through `cmd.exe` with `windowsVerbatimArguments` for correct argument quoting on Windows.

5. **Fixed voice message transcription for m4a/mp4 audio** — audio MIME values including m4a aliases are now normalized before provider handling. m4a files are transcoded to WAV via ffmpeg for OpenAI `input_audio` compatibility, while OGG/Opus conversion continues on its own path.

6. **Fixed opencode `tool-output` directory access** — the `tool-output` directory (used by opencode for file outputs) is now allowed by default so agents can write outputs without hitting permission errors.

## 0.4.76

1. **SSE wire format for programmatic gateway events** — `kimaki --gateway` in headless/non-TTY mode now emits events using the SSE wire format (`data: {...}\n\n`) instead of bare JSON lines. This lets consumers use the `eventsource-parser` npm package to reliably extract events even when log noise, warnings, or spinner output is interleaved on stdout:
   ```ts
   import { createParser } from 'eventsource-parser'
   const parser = createParser((event) => {
     if (event.type === 'event') {
       const e = JSON.parse(event.data) // ProgrammaticEvent
     }
   })
   // pipe kimaki stdout chunks into parser.feed(chunk)
   ```
   The event shape is unchanged (`install_url`, `authorized`, `ready`, `error`).

2. **Default channel and welcome message created in headless mode** — when spawning `kimaki --gateway` programmatically (non-TTY), the default `#kimaki` channel and onboarding welcome thread are now created automatically after the bot connects, matching what the interactive setup flow does.

3. **Fixed gateway `--gateway-callback-url` redirect** — the `--gateway-callback-url` CLI option was silently ignored: the OAuth callback hook returned a double-wrapped response object instead of a `302 Response`, so users always landed on `/install-success` regardless of the custom URL.

4. **Fixed question tool duplicate prompt on text answer** — when the model used the question tool and the user replied with a plain text message instead of using the dropdown, the message was sent both as a question answer and as a new prompt, causing repeated abort/retry cycles. Text answers now skip the re-enqueue path.

5. **Fixed question tool TTL expiry behavior** — when the 10-minute timeout expired on a pending question, the bot was sending `['Other']` as a fake answer — causing the model to act on a choice the user never made. On expiry it now aborts the session silently without faking a selection.

6. **Fixed race between question dropdown click and session abort** — deleting the pending question context before calling `session.abort()` prevents a late dropdown click during the async abort from being accepted and then immediately killed.

7. **More punctuation supported in `. queue` suffix** — `!`, `?`, `,`, `;`, `:` are now accepted before `queue` in addition to `.`, and a trailing period is optional. Patterns like `Fix the bug! queue` or `Do this? queue.` now work.

## 0.4.75

1. **Default Kimaki channel created on onboarding** — a `kimaki-{botName}` channel (or `kimaki` in gateway mode) is now automatically created in the Kimaki category for general-purpose tasks. It's not tied to a project — the backing directory is `~/.kimaki/projects/kimaki`, initialized with git. Idempotent: skipped if the channel already exists.

2. **Welcome message and onboarding tutorial** — the default channel gets a welcome message on first creation explaining what Kimaki is. Sending your first message triggers a built-in tutorial that guides you through building a 3D Space Dodge game with Three.js + kimaki tunnel.

3. **Non-TTY gateway mode with JSON event protocol** — `kimaki --gateway` now works in headless environments (cloud sandboxes, CI, Docker). Instead of interactive prompts, it emits structured JSON lines:
   ```json
   {"type":"install_url","url":"..."}
   {"type":"authorized","guild_id":"..."}
   {"type":"ready","app_id":"...","guild_ids":[...]}
   {"type":"error","message":"..."}
   ```
   This makes it easy to script gateway onboarding without a terminal.

4. **`kimaki bot` command group** — new CLI subcommands to manage bot presence:
   ```bash
   # set bot status
   kimaki bot status set "Working on your code" --type playing --status online

   # clear bot status
   kimaki bot status clear

   # print bot install URL
   kimaki bot install-url
   ```
   Note: status commands are blocked in gateway mode since presence is global (shared bot).

5. **`/model-variant` command** — quickly switch the thinking level for the current model without going through the full `/model` menu. Shows variant and scope pickers in a single reply.

6. **`/mcp` command** — list and toggle MCP servers for the current project:
   - Shows all configured MCP servers with their status (connected/disconnected/error)
   - Select a server from the dropdown to connect or disconnect it

7. **`. queue` suffix support** — append `. queue` to any regular text message to queue it for after the current session finishes, same as the `/queue` command:
   ```
   Fix the login bug. queue
   ```

8. **Queue drains after session errors** — messages stuck in the local queue are now dispatched even if the session ended with an error, preventing stuck voice transcriptions.

9. **Worktree action buttons in `/worktrees` table** — delete buttons now appear directly in the worktrees table rows. Force-remove works even when the worktree folder contains submodules. Base and target branch autocomplete added to worktree commands.

10. **Footer anchored to assistant completion** — the run footer (`kimakivoice ⋅ main ⋅ 2m 30s ⋅ 71% ⋅ ...`) is now sent immediately after the last text part instead of being delayed, preventing spurious footers from appearing after interruptions.

11. **Runtimes reconnect after shared server restart** — `/restart-opencode-server` now properly reconnects all active thread runtimes after the server comes back up.

12. **Common directories pre-allowed for permissions** — system paths like `~/.npm`, `~/.cargo`, `/tmp`, and similar build caches are automatically allowed at the guild level, reducing permission prompts for common tool operations.

13. **Voice `[inaudible audio]` for incomprehensible input** — very short or inaudible voice messages now return `[inaudible audio]` instead of triggering a transcription error.

14. **`--gateway-callback-url` CLI option** — customize the OAuth redirect URL after bot authorization, useful for self-hosted website deployments.

15. **Memory leak fixes** — comprehensive cleanup of runtime and pending-UI state when sessions end, preventing accumulation of stale state across long-running bot processes.

## 0.4.74

1. **`kimaki session archive` and `kimaki user list` CLI commands** — Discord REST operations previously done by plugin tools (`kimaki_archive_thread`, `kimaki_list_discord_users`) are now proper CLI subcommands. The plugin tools were silently broken in gateway mode because they had no way to route requests through the proxy:
   ```bash
   # archive a thread by session ID
   kimaki session archive --session ses_abc123
   # list Discord users in the guild (with optional search)
   kimaki user list --guild 123456789 --query alice
   ```
   `kimaki_mark_thread` was removed (unused). The plugin no longer receives `KIMAKI_BOT_TOKEN`, eliminating the credential leak into child processes.

2. **Fixed `kimaki send` failing with 401 in gateway mode** — `resolveBotCredentials` now reads from the database first (which correctly sets the gateway proxy URL), falling back to the `KIMAKI_BOT_TOKEN` env var only for headless/CI deployments. Previously, subcommands always sent credentials directly to discord.com instead of through the proxy.

3. **Fixed bot mode selection for subcommands** — `send`, `project list`, `upload-to-discord` and other short-lived subcommands now correctly detect whether gateway or self-hosted mode is active. The fix uses a persistent `last_used_at` timestamp on the bot token row that the main bot stamps at startup, giving cross-process subcommands a reliable source of truth without any in-memory flags.

4. **Fixed queued message interrupt timing** — queued follow-up messages now abort as soon as the current assistant turn hits a blocking step-finish, instead of waiting for a hard timeout. The interrupt plugin also correctly waits for the aborted assistant message to propagate before resuming, preventing race conditions where resume could fire before abort was fully settled.

5. **Fixed empty resume messages appearing as queued work** — the interrupt plugin's internal `promptAsync({ parts: [] })` resume calls are no longer mistakenly tracked as pending user messages.

6. **Worktree creation more resilient to broken submodule configs** — partially-removed submodules (deleted from the tree but still referenced in `.gitmodules`) no longer block worktree creation; the error is logged as a warning and the worktree is returned normally.

7. **`/worktrees` capped at 10 entries** — keeps the ephemeral response compact when many worktree sessions have accumulated.

## 0.4.73

1. **New `/worktrees` slash command** — list all active worktree sessions with branch, status, and age; handles deleted worktree folders gracefully
2. **New `/stop-opencode-server` command** — manually stop the OpenCode server for the current project channel
3. **OpenCode servers auto-stop after 2 hours of inactivity** — idle server processes are cleaned up automatically to free resources
4. **Agent name shown in thread messages** — messages now prefix with the active agent name (e.g. `[build-agent]`) instead of the generic `task` label
5. **Tool calls from previous sessions hidden** — resuming a session no longer replays tool call messages from earlier runs in the thread
6. **Stale action buttons cleaned up** — action buttons left over from ended sessions are properly removed
7. **Legacy global slash commands removed on startup** — outdated global commands are automatically cleaned up when the bot registers guild commands
8. **`--gateway` CLI flag** — force gateway mode even when self-hosted credentials are already saved, useful for switching between modes
9. **`/login` providers sorted by popularity** — most-used providers (Anthropic, OpenAI, etc.) are listed first
10. **`/verbosity` uses a dropdown** — replaced text input with a select menu for a better UX when setting output verbosity
11. **Fixed duplicate context usage notices** — context percentage no longer appears twice before the run footer
12. **Fixed queued message delivery timing** — queued messages now wait for the current run to fully complete before dispatching
13. **Bot explains unlinked channels** — when `@mentioned` in a channel not linked to a project, the bot now sends a helpful explanation
14. **Fixed typing indicator stuck after `/abort`** — typing indicator now properly clears when aborting a session
15. **Fixed interrupt messages showing `»` prefix** — messages after an abort no longer show the queue indicator prefix
16. **`/queue` confirmation delayed until dispatched** — queue echo is shown only after the message is actually placed in the queue
17. **Voice messages show queue position** — queued voice messages now display their queue position number
18. **`~/.kimaki` always accessible** — OpenCode sessions no longer trigger permission prompts when reading kimaki config files
19. **Smart bot auto-selection** — picks the correct bot configuration automatically when multiple bots are configured in the database
20. **`--restart-onboarding` flag renamed from `--restart`** — more descriptive name for the flag that re-runs the setup wizard

## 0.4.72

1. **Fixed plugin tools silently missing** — `kimaki_action_buttons`, `kimaki_file_upload`, `kimaki_mark_thread`, and other plugin tools were silently missing on some OpenCode versions due to a crash in the plugin loader; the root cause (an extra exported function confusing the loader) is now fixed
2. **Voice "queue this message" intent** — say "queue this message" (or similar) in a voice note while the AI is working and the message is queued instead of interrupting the current session
3. **Voice reliability fixes** — three race conditions fixed: active-session state is now snapshotted at message arrival so voice messages queue correctly even if the previous task finishes during transcription; transcription failures no longer send empty prompts; the "queued" label is only shown after the actual queuing decision
4. **Log file now at `~/.kimaki/kimaki.log`** — logs are written in all environments (was only written in dev mode before); the AI model is also told where to find the file for self-diagnosis
5. **Secrets scrubbed from logs and error reports** — API keys, Bearer tokens, and other credentials are now redacted from log output and Sentry payloads; non-sensitive identifiers like Discord IDs and channel names are preserved for debugging
6. **Fixed Discord permission checks for uncached members** — member role/permission lookups now handle both cached class instances and raw API payload shapes, fixing permission errors for users whose data wasn't in the bot's cache (thanks @ajoslin in #57)
7. **Fixed atomic worktree database writes** — worktree state is now written atomically to prevent rare race conditions (thanks @ajoslin in #58)
8. **New built-in skills: `simplify`, `batch`, `security-review`** — three skills extracted from Claude Code CLI are now available to the AI agent in every Kimaki session

## 0.4.71

1. **Fixed package.json dependency classification** — `opencode-deterministic-provider` moved from `dependencies` to `devDependencies` so it no longer appears as a runtime dependency in the published package

## 0.4.70

1. **Immediate interrupt handling** — sending a new message while the AI is working now aborts the running session at the next step boundary, so your follow-up is processed right away instead of waiting for the full response to finish
2. **Memory simplified to `MEMORY.md`** — the `--memory` flag and Discord forum-based memory infrastructure are removed; the agent now reads and updates a `MEMORY.md` file in your project root automatically, with no flags or setup required
3. **Agent descriptions in system prompt** — all configured agents and their descriptions are now injected into the session context so the AI can make smarter agent selection decisions
4. **Slash command name fixes** — user-defined commands containing slashes, colons, or other special characters now register and route correctly in Discord
5. **Voice transcription reliability** — voice messages are now processed in the correct order; the transcription model no longer accidentally answers user questions; stale transcriptions from previous sessions are no longer reused
6. **Worktree creation fixes** — worktree creation no longer fails due to broken dependency install steps (`ni` and `--frozen-lockfile` removed)
7. **Fork dropdown filtering** — the `/fork` message picker no longer shows internal synthetic messages, only real user and assistant turns
8. **Large tool output truncation** — tool call outputs exceeding 30k characters are truncated to prevent context window overflow during session reads
9. **Permission prompt suppression** — the agent no longer triggers permission prompts when accessing `MEMORY.md` and other config paths

## 0.4.69

### Patch Changes

- feat: **OpenAI voice transcription** — new `/transcription-key` command stores API key for voice message transcription; auto-detects provider from key prefix (`sk-*` → OpenAI, otherwise Gemini)
- feat: **`gpt-4o-audio-preview` transcription model** — uses the chat completions API with OGG-to-WAV conversion for high-quality voice-to-text; falls back gracefully on decode errors
- feat: **in-process Hrana v2 server** — replaces the 39 MB `sqld` Rust binary with a lightweight Node.js HTTP server speaking the [Hrana v2 protocol](https://github.com/tursodatabase/libsql/blob/main/docs/HTTP_V2_SPEC.md), backed by `libsql`; eliminates a large binary dependency and startup overhead
  ```
  Before: sqld child process (39 MB Rust binary)
  After:  in-process HTTP server on the lock port — same Prisma adapter, no separate process
  ```
- feat: **bot-to-bot sessions** — bots with the Kimaki role can now trigger OpenCode sessions; a self-message guard prevents infinite loops when the bot also has the Kimaki role
- feat: **action button TTL extended to 24 hours** — buttons no longer expire after 30 minutes, so late replies to pending confirmations still work
- feat: **auto-derive App ID from bot token** — no interactive prompt needed; when `KIMAKI_BOT_TOKEN` is set the App ID is extracted automatically
- feat: **thread ID in system prompt** — `threadId` is now injected into the OpenCode system prompt so agents can reference the current Discord thread for scheduling reminders (`--send-at`)
- feat: **termcast skill** — new built-in skill for building Raycast-style TUIs with React in the terminal via `termcast`/`opentui`
- feat: **memory forum auto-tags** — project tags are created automatically on the memory forum channel; embeds are suppressed in forum messages for cleaner appearance
- fix: **remove `/upgrade-and-restart` command** — the command caused confusion and is no longer needed (fixes #49)
- fix: **`/login` and `/model` dropdowns sorted** — provider and model options are now sorted alphabetically for easier scanning
- fix: **archive thread delay** — increased from 5 s to 10 s so the final bot message is readable before the thread hides from the sidebar
- fix: **project channel footer** — footer now survives the Discord 2000-char limit and falls back gracefully on empty body
- fix: **test isolation** — vitest runs now auto-isolate from the real `~/.kimaki/` database via `KIMAKI_VITEST` env var injected by `vitest.config.ts`
- fix: **`waitForServer` simplified** — all scripts now poll only `/api/health` (matching `opencode.ts`) and use `127.0.0.1` to avoid DNS/IPv6 ambiguity

## 0.4.68

### Patch Changes

- feat: **`kimaki_action_buttons` tool** - AI can now show Discord buttons for quick confirmations; buttons are dismissed automatically when user sends a new message
- feat: **persistent memory** - `--memory` flag enables a project-scoped memory folder synced as a Discord forum channel, with system prompt instructions injected each session
- feat: **global memory scope** - memory forum threads can be tagged as global to share context across all projects
- feat: **scheduled tasks** - `kimaki send --send-at` allows scheduling messages to run at a future UTC time, with cron-style recurring tasks supported
- feat: **forum markdown sync engine** - bidirectional sync between Discord forum channels and local markdown files, replacing `forum-sync.json` with SQLite-backed config
- feat: **session origin tracking** - track where sessions were started (slash command, message, scheduled task, etc.) for better diagnostics
- feat: **project list improvements** - `kimaki project list` now shows Discord channel name and folder name
- fix: **action button rendering** - render action buttons after stream flush and hide tool call output during button wait
- fix: **agent/model preference snapshots** - correctly snapshot thread agent and model preferences at session start
- fix: **archive-thread race** - parallelize footer async calls to eliminate archive-thread race condition
- fix: **session idle race** - resolve deferred session idle race in interactive flows (permissions, questions, file uploads)
- fix: **worktree parent row** - ensure `thread_sessions` parent row exists before creating worktree child row
- fix: **file attachments in bot-initiated threads** - read file attachments correctly when thread is started by the bot
- fix: **resume stuck forever** - fix `/resume` command getting stuck on "Loading N messages..." indefinitely
- fix: **interactive UI echo** - prevent user messages from being echoed back when flushing interactive UI state
- fix: **duplicate part output** - prevent duplicate part output on interrupted/replayed runs
- fix: **send-at UTC format** - require explicit UTC date format for scheduled task timestamps
- fix: **startup timeout errors** - include opencode stderr tail in startup timeout error messages for easier debugging
- perf: **non-blocking quick-start** - bot startup is now non-blocking so the ready message appears faster

## 0.4.67

### Patch Changes

- feat: **`/session-id` command** - new slash command shows current session ID and `opencode attach` command to connect directly from terminal
- fix: **harden opencode plugin hooks** - wrap `chat.message` and `event` hooks in `errore.tryAsync` to prevent unhandled rejections from crashing the plugin; log warnings instead
- fix: **file upload timeout** - replace `AbortSignal.timeout()` with explicit `AbortController` + `errore.tryAsync` for cleaner error handling in `kimaki_file_upload` tool
- fix: **suppress embed previews** in `/model` confirmation replies to avoid noisy link unfurls
- fix: **label voice transcriptions** - prepend `Voice message transcription from Discord user:` prefix so the model understands the message origin
- fix: **`/context-usage` format** - show percentage first (`95%, 12,345 / 13,000 tokens`) for quicker scanning
- docs: **`kimaki tunnel` help** - clarify that custom `--tunnel-id` is only safe for services meant to be public
- chore: **update tuistory skill** guidance from upstream
- chore: **bump traforo submodule** after Retry-After fix

## 0.4.66

### Patch Changes

- feat: **session search command** - add `kimaki session search <query>` CLI command to search past conversations with text or regex patterns
- feat: **plugin branch detection** - inject synthetic parts showing current branch and branch changes mid-session
- feat: **plugin idle-time awareness** - inject timestamp parts when >10min elapsed between messages
- feat: **skill tool visibility** - show skill invocations (playwriter, tuistory, jitter) in essential tools verbosity mode
- feat: **verbose OpenCode server flag** - add `--verbose-opencode-server` to forward server logs to kimaki.log for debugging
- feat: **skills infrastructure** - sync-skills script clones and discovers skills from remote repos, add skills paths to OpenCode config
- feat: **V8 heap snapshots** - inject `--heapsnapshot-near-heap-limit=3` to catch OOM crashes before SIGKILL
- feat: **CLI upgrade restart** - `kimaki upgrade` now automatically restarts the running bot after upgrading
- fix: **read-only explore permissions** - prevent explore subagents from inheriting global allow rules for edits and bash
- fix: **typing indicator lifecycle** - clear delayed typing restarts on session cleanup to prevent zombie typing
- fix: **detached git state warnings** - detect detached HEAD and detached submodule states in branch context
- fix: **message content truncation** - truncate unbounded error messages and AI text to prevent Discord API errors (fixes #38)
- fix: **archive delay** - increase from 3s to 5s so final messages are read before thread hides
- refactor: **migrate to SDK v2** - complete migration from @opencode-ai/sdk v1 to v2 flat parameter convention
- chore: **increase bash inline threshold** - raise from 50 to 100 chars for better command visibility
- chore: **bump errore to 0.12.0** - includes cleanup/cancellation docs and SuppressedError handling
- docs: add **traforo comprehensive guide**, essential tools filtering reference, plan-first guidance for cross-project prompts

## 0.4.65

### Patch Changes

- feat: **store model variant** in model tables with session/channel/global cascade for thinking level preferences
- perf: **parallelize session-handler** async operations for faster session initialization
- fix: **guard against non-hydrated guild members** in permission check to prevent crashes
- fix: **parallelization bugs** in session-handler affecting concurrent operations
- fix: **keep /fork customId under 100 chars** to comply with Discord's custom_id length limit
- fix: **remove decimal digits** from session duration in footer for cleaner display
- refactor: **replace deprecated ephemeral: true** with MessageFlags.Ephemeral
- style: **run oxfmt formatter** across src for consistent code style
- docs: add **tool permissions section** to README
- docs: clarify **--thread vs --session** usage
- docs: document **long --wait timeout** + fallback behavior
- docs: warn about **Discord custom_id length limit** in agents instructions

## 0.4.64

### Patch Changes

- feat: **search across all projects** in `kimaki session read` when session not found in current project
- feat: add **--no-critique flag** to disable automatic diff uploads to critique.work (addresses #37)
- fix: **improved Discord markdown rendering** - prevent list/code block concatenation that breaks Discord parsing
- fix: **silently remove permission buttons** on auto-reject instead of sending warning message
- fix: **abort all active sessions** before restarting OpenCode server to prevent orphaned requests
- refactor: **rely on marked AST** for list/code formatting instead of regex splitting

## 0.4.63

### Patch Changes

- fix: **pin Prisma to 7.3.0** to avoid startup crash in fresh installs (Prisma 7.4.x `reading 'graph'`)
- fix: **print stack traces** for unhandled errors and Prisma init failures to make install-time crashes debuggable
- fix: **avoid echoing shell command args** back into the channel
- fix: **remove expired permission messages** by silently removing buttons
- refactor: **remove Vercel AI SDK tool helper dependency** (keep a minimal local tool definition)
- style: use `*italic*` instead of `_italic_` in session completion messages

## 0.4.62

### Patch Changes

- feat: **show project folder and git branch** in session completion message for better context
- feat: **unify /model scope selection** for threads and channels - consistent UX
- feat: **enable SQLite WAL mode** with busy_timeout for better concurrency
- fix: **hide session cost line** in /context-usage when cost is zero

## 0.4.61

### Patch Changes

- feat: add **/context-usage** slash command to show token usage and context window percentage
- feat: add **/queue-command** slash command for queuing user commands
- feat: add **--wait flag** to `kimaki send` command
- feat: add **open-in-discord** subcommand to `kimaki project`
- feat: **improve quick agent command replies** with context and validation
- perf: **speed up agent quick commands** by skipping OpenCode server check
- fix: **show context percentage** for large tool outputs
- fix: **snapshot model and agent** at message arrival to prevent race conditions with `/agent` command
- fix: **fail fast** on invalid session agent
- refactor: **remove context usage breakdown** line from `/context-usage` command

## 0.4.60

### Patch Changes

- feat: **show current agent** in /agent command reply
- fix: **harden schema migration** SQL parsing to prevent startup crashes on malformed SQL
- fix: **keep only error reaction** on thread messages to reduce visual noise
- refactor: **reuse thread archive flow** in CLI and plugin for consistent behavior
- chore: **migrate CLI parser** to goke for better argument handling

## 0.4.59

### Patch Changes

- feat: **render tables as Discord Components V2** instead of code blocks for better readability
- feat: move session **list/read commands to CLI** (`kimaki session list`, `kimaki session read`) to save token usage
- feat: rename **add-project** CLI references to **project add**
- style: simplify **table keys** to bold only

## 0.4.58

### Patch Changes

- fix: **inline `tool()` helper** to avoid `@opencode-ai/plugin/tool` subpath import that fails in global npm installs (fixes #35)
- fix: remove double newlines from permission request messages
- fix: remove **opencode version check** at startup (replaced by background auto-upgrade)
- feat: **auto-upgrade opencode** in background on bot startup
- chore: update opencode deps to 1.1.53

## 0.4.57

### Patch Changes

- fix: move **@opencode-ai/plugin** from devDependencies to dependencies so it's available in global installs (fixes #35)
- feat: add **opencode version check** at startup - exits with clear message if installed opencode is older than 1.1.51
- feat: add **`project` subcommands** - `kimaki project list`, `kimaki project create`, `kimaki project add` (alias for `add-project`)
- feat: **`send` defaults to cwd** when neither `--channel` nor `--project` is provided
- feat: add **cross-project commands** documentation in system message
- fix: **strip mentions from thread titles** so `<@123>` doesn't appear in thread names
- fix: check **mention mode before permissions** to avoid sending permission errors to users who just didn't @mention the bot
- fix: `add-project` exits with **non-zero code** when channel already exists

## 0.4.56

### Patch Changes

- feat: add **emoji reactions** for thread marking (✅ for completion, 🌳 for worktrees)
- feat: add **archive thread** tool to close threads and remove them from Discord sidebar
- feat: add **/diff** command to view and share git diffs via web interface
- feat: enhance **permission buttons** with better styling (Success/Secondary/Danger)
- feat: change **default verbosity** to `text-and-essential-tools` to reduce noise
- fix: **resolve Discord mentions** to usernames in prompts and thread titles
- fix: skip logging **abort errors** as they are expected behavior
- fix: ensure **permission buttons** work correctly by removing dead code
- fix: proper handling of **thread closing** with timeouts

## 0.4.55

### Patch Changes

- feat: migrate database to **Prisma** for type-safe queries and better schema management
- fix: restore **idempotent schema** initialization to ensure database consistency on startup
- refactor: add **foreign key relations** to database schema

## 0.4.54

### Patch Changes

- feat: add **--domain** flag to tunnel command (defaults to `kimaki.xyz`)
- update **traforo** dependency with parametrizable base domain support

## 0.4.53

### Patch Changes

- feat: add **/login** command to authenticate with AI providers
- feat: show **current model info** in `/model` command response
- feat: show **task agent** name in Discord status/messages
- feat: add **worktree toggle** instead of enable/disable commands
- fix: **filter bash tools** by side effects to prevent accidental execution
- refactor: switch to **@xmorse/cac** for CLI parsing and add **npx kimaki tunnel** command
- refactor: consolidate resume commands to **/resume**

## 0.4.52

### Patch Changes

- feat: include **Discord CDN URLs** for image attachments in prompts so agents can fetch images if needed
- feat: always pass **explicit model** to OpenCode like TUI does for consistent behavior
- fix: check **config.model** before recent models for default model selection
- fix: add **suggestion to use CLI** for unlisted projects in add-project command
- update **errore** submodule

## 0.4.51

### Patch Changes

- feat: add **no-kimaki role** to block users from bot access even with owner/admin permissions (thanks @TotalLag for the suggestion)
- feat: disable **voice channels by default**, add `--enable-voice-channels` flag to opt-in

## 0.4.50

### Patch Changes

- feat: add **text-and-essential-tools** verbosity level - shows text + edits + custom MCP tools, hides read/search/navigation
- fix: **image handling** - send images as base64 data URLs with resizing, don't embed in prompt text
- fix: add **HEIC support** for image attachments

## 0.4.49

### Patch Changes

- fix **bracketed paste mode** causing setup to loop on macOS iTerm2 (thanks @ariane-emory for reporting)

## 0.4.48

### Patch Changes

- feat: add **discord username prefix** to AI prompts and ignore non-bot mentions
- feat: make **verbosity apply mid-session** and add `--verbosity` default flag
- fix: **gate session idle completion** to prevent premature session ends
- fix: **show apply_patch file names** from input instead of output
- fix: **filter hidden agents** from new-session autocomplete
- fix: **handle permission requests** from subtask sessions
- fix: log ignored errors and gate idle abort
- refactor: simplify waitForServer to check single health endpoint
- refactor: createNewProject extraction
- update **@clack/prompts** to latest

## 0.4.47

### Patch Changes

- add **/compact** command to trigger session context compaction
- add **caffeinate** spawn on macOS to prevent system sleep during sessions
- add **rate limit status** display in Discord when OpenCode is retrying
- add **apply_patch tool** display like edit with square icon and file summary
- add **uncommitted changes transfer** to worktree when using /new-worktree in threads
- fix **subtask separator** - use ⋅ and fix double spaces in tool output
- fix **stale session.idle events** ignored before content received
- fix **apply_patch tool** summaries defensive handling
- fix **abort reason** - pass Error to .abort() to prevent string leaking
- fix **whitespace normalization** in tool call arguments for Discord display
- fix **question tool answer** - send user message instead of 'cancelled'
- fix **blank lines** removed from command response messages
- refactor **log prefixes** shortened to max 8 chars with LogPrefix enum and picocolors

## 0.4.46

### Patch Changes

- fix **subtask output** hidden in text-only verbosity mode (thanks @xHeaven for reporting)
- fix **add users to threads** so they appear in sidebar
- fix **serialize discord event handlers** to prevent race conditions

## 0.4.45

### Patch Changes

- add **/verbosity** command for text-only mode toggle
- add **/new-worktree** support for existing threads
- fix **queued messages** sent after session completion
- fix **add-project --guild** flag for large Discord IDs
- fix **dedupe permission dropdowns** to prevent duplicate prompts
- fix **markdown chunk splitting** to prevent exceeding Discord limit
- refactor session event flow to use **errore** typed errors
- refactor **channel config** from XML topic to SQLite storage

## 0.4.44

### Patch Changes

- fix **send auto-start race condition** - use embed marker instead of database lookup
- add **/merge-worktree** command to merge worktree branch into main with ⬦ thread prefix
- add **/toggle-worktrees** command for channel settings
- add **--use-worktrees** flag for automatic worktree creation on new sessions
- add **add-project** CLI command with worktree submodule/deps init
- fix **merge-worktree** non-fast-forward handling, uncommitted changes check, detached HEAD support

## 0.4.43

### Patch Changes

- feat: handle **2000 char limit** in send command with automatic splitting
- fix: track **multiple pending permissions** per thread to prevent duplicates and hangs
- update **errore** to 0.9.0 (breaking: `_` → `Error` in matchError)

## 0.4.42

### Patch Changes

- fix **npx kimaki@latest** failing - update errore to 0.8.0 with fixed npm exports
- add **quick start mode** - skip OpenCode init when setup already done for faster bot startup
- refactor CLI into smaller helper functions for better maintainability

## 0.4.40

### Patch Changes

- add **/new-worktree** command to create git worktrees from Discord
- rename `/session` → **/new-session** for clarity
- fix **SSE deadlock** by increasing connection pool size
- fix **worktree thread creation** - check if worktree exists before creating thread
- fix **worktree message editing** - edit starter message when ready instead of sending new one
- send **multiple images in single message** for grid display
- migrate to **createTaggedError** factory for typed error handling
- update **errore** submodule to 0.7.1

## 0.4.39

### Patch Changes

- fix **0% token usage** race condition by fetching from API instead of relying on cached values
- display **subtask events** with indexed labels (explore-1, explore-2) for better tracking
- **filter hidden agents** from agent lists
- adopt **errore typed errors** across discord bot for better error handling

## 0.4.38

### Patch Changes

- fix **duplicate "kimaki"** in category names - now creates "Kimaki" instead of "Kimaki kimaki" when bot is named kimaki

## 0.4.37

### Patch Changes

- rename `start-session` → **`send`** command (alias kept for backwards compat)
- add **`--notify-only`** flag to create notification threads without starting AI session
- add **`app_id`** column to channel_directories for multi-bot support
- fix **JS number precision loss** for large Discord IDs in CLI arguments
- add **subfolder lookup** - walks up parent directories to find closest registered project
- fix **notification thread replies** to start new session with notification as context

## 0.4.36

### Patch Changes

- add **--project** option to `start-session` CLI command as alternative to `--channel`
- add **/remove-project** command to delete channels for a project from Discord
- add **agent** option to `/session` command for starting sessions with specific agent
- fix: use first option as **placeholder** in question tool dropdowns
- fix: limit Discord **command names to 32 characters**
- add **keep-running instructions** to CLI setup outro

## 0.4.35

### Patch Changes

- use **opencode from PATH** instead of hardcoded `~/.opencode/bin/opencode` path

## 0.4.34

### Patch Changes

- fix **numbered list code block unnesting** to avoid repeating numbers
- **send text parts immediately** when complete (time.end set)
- don't show typing indicator on question tool prompts
- instruct model to use **question tool on session end**
- fix(cli): **sanitize command names** by replacing colons with hyphens

## 0.4.33

### Patch Changes

- use **digit-with-period unicode** (⒈⒉⒊) for todo numbers instead of parenthesized digits
- add **heading depth limiter** for Discord markdown (converts h4+ to h3)

## 0.4.32

### Patch Changes

- feat: **flush pending text** before tool calls - ensures LLM text is shown before tools start
- feat: **show token usage** for large tool outputs (>3k tokens) with context percentage

## 0.4.31

### Patch Changes

- feat: **auto-create Kimaki role** on CLI startup for easier permission management
- feat: add **--install-url** CLI option to print bot invite URL without starting bot
- feat: **unnest code blocks from lists** for Discord compatibility
- perf: **parallelize CLI startup** operations for faster boot
- fix: **cancel pending question** when user sends new message
- fix: **flush pending text** before showing question dropdowns
- fix: **reply with helpful message** when user lacks Kimaki role
- fix: move **Kimaki role to bottom** position for easier assignment
- fix: prevent **infinite loop** in splitLongLine with small maxLength
- fix: context usage rendering with empty diamond symbol

## 0.4.30

### Patch Changes

- add **start-session** CLI command to programmatically create Discord threads and start sessions
- support **KIMAKI_BOT_TOKEN** env var for headless/CI usage
- add **ThreadCreate** handler to detect bot-initiated sessions with magic prefix
- add **channelId** to system prompt for session context
- add GitHub Actions example for automatic issue investigation
- docs: update README command table with /agent, /undo, /redo

## 0.4.29

### Patch Changes

- add **--data-dir** option for running multiple bot instances with separate databases
- **abbreviate paths** in project selection with `~` for home directory
- **filter out** `opencode-test-*` projects from channel creation lists
- docs: add multiple Discord servers section to README

## 0.4.28

### Patch Changes

- fix **Accept Always** not persisting - use v2 API (`permission.reply`) instead of deprecated v1 API

## 0.4.27

### Patch Changes

- replace `/accept`, `/accept-always`, `/reject` commands with **dropdown menu** for permission requests
- show Accept, Accept Always, and Deny options in a single dropdown

## 0.4.26

### Patch Changes

- add Discord dropdowns for AI question tool prompts
- add **/agent** command to set agent preference per channel or session
- add user-defined OpenCode slash command support
- add dev-mode file logging
- add abort-and-retry flow when switching models mid-session
- add graceful shutdown with SIGTERM before SIGKILL and **/stop** alias
- add image attachment downloads with prompt path inclusion
- add bot username to category names for multi-bot support
- fix OpenCode server startup reliability
- fix transcription errors sent to thread instead of channel
- fix long-line markdown splitting and inline markdown escaping
- fix `-cmd` command parsing
- chore: update **@opencode-ai/sdk** to 1.1.3 and gitignore tmp
- chore: simplify system prompt and silence noisy debug log
- refactor: update Discord message icons and formatting

## 0.4.25

### Patch Changes

- add **/queue** command to queue messages during active sessions
- add **/clear-queue** command to clear queued messages
- add **/undo** and **/redo** commands for session history navigation
- add **/fork** improvements - show last assistant message in selection
- feat: **auto-kill existing kimaki instance** instead of failing when another instance is running
- fix: **prevent killing own process** when checking for existing instance (use `-sTCP:LISTEN` flag)
- feat: **notification badge** on session completion message
- feat: **lowercase capitalization rules** in system prompt for Discord-style messaging
- refactor: extract commands into separate files with cleaner dispatcher

## 0.4.24

### Patch Changes

- add **test-model-id.ts** script for validating model ID format and provider.list API
- cleanup **pnpm-lock.yaml** - remove stale liveapi dependencies

## 0.4.23

### Patch Changes

- fix **command timeouts**: fixed issue where `/fork`, `/abort`, and `/share` commands would time out by deferring replies immediately
- fix **startup race condition**: fixed issue where interaction handlers were not registered if the client was already ready during startup
- add **/model command**: new command to set preferred model for a channel or session
- update **/model** to use dropdowns with models sorted by release date (newest first)
- improve **customId handling**: use hash keys for select menus to avoid Discord's 100-char limit on custom IDs

## 0.4.22

### Patch Changes

- add **table formatting** for Discord - markdown tables are converted to monospace code blocks for better readability
- add `formatMarkdownTables` utility and tests

## 0.4.21

### Patch Changes

- add **Manage Server** permission to allowed users (in addition to Owner/Admin)
- add **"Kimaki" role** support - users with a role named "Kimaki" (case-insensitive) can now interact with the bot
- add **model configuration** info to system prompt - explains how to change model via `opencode.json`
- update README with permissions and model configuration docs

## 0.4.20

### Patch Changes

- add **200ms debounce** after aborting interrupted sessions to prevent race conditions
- fix **race condition** where requests could hang if aborted between checks and async calls
- remove slow Discord API calls - use local SQLite for tracking sent parts instead of fetching messages
- move **⏳ reaction** to right before prompt (not on message arrival) so superseded requests don't leave orphaned reactions
- show **filename in italics** for edit/write tools: `◼︎ edit _file.ts_ (+5-3)`
- use **italics** for bash commands and tool titles instead of backticks

## 0.4.19

### Patch Changes

- add **single instance lock** to prevent running multiple kimaki bots
- add `/add-new-project` command to create project folder, init git, and start session
- add `/share` command to share current session as public URL
- show **tool running status** immediately instead of waiting for completion
- inform user that **bash outputs are not visible** in system prompt
- add README best practices for notifications, long messages, permissions

## 0.4.18

### Patch Changes

- mention long files as uploadable in system prompt

## 0.4.17

### Patch Changes

- remove misleading error message in upload-to-discord

## 0.4.16

### Patch Changes

- move upload-to-discord instructions to system prompt instead of separate command

## 0.4.15

### Patch Changes

- re-publish with CLI command fixes

## 0.4.14

### Patch Changes

- add `upload-to-discord` CLI command to upload files to Discord thread
- add `/upload-to-discord` OpenCode command for LLM-driven file uploads
- refactor system prompt to include session ID for LLM access
- remove plugin dependency - commands now instruct LLM to run CLI directly
- rename command files to support multiple commands

## 0.4.13

### Patch Changes

- bash tool displays actual command in inline code (`` `command` ``) instead of description when short (≤120 chars, single line)

## 0.4.12

### Patch Changes

- system prompt instruction for 85 char max code block width to prevent Discord wrapping

## 0.4.11

### Patch Changes

- preserve code block formatting when splitting long Discord messages
- add closing/opening fences when code blocks span multiple messages
- use marked Lexer for robust markdown parsing instead of regex

## 0.4.10

### Patch Changes

- show "Creating Discord thread..." toast at start of command
- update command description to clarify it creates a Discord thread

## 0.4.9

### Patch Changes

- improve error handling in OpenCode plugin, check stderr and stdout for error messages

## 0.4.8

### Patch Changes

- add `send-to-discord` CLI command to send an OpenCode session to Discord
- add OpenCode plugin for `/send-to-kimaki-discord` command integration

## 0.4.7

### Patch Changes

- add `/accept`, `/accept-always`, `/reject` commands for handling OpenCode permission requests
- show permission requests in Discord thread with type, action, and pattern info
- `/accept-always` auto-approves future requests matching the same pattern

## 0.4.6

### Patch Changes

- add support for images
- update discord sdk

## 0.4.5

### Patch Changes

- Batch assistant messages in resume command to avoid spamming Discord with multiple messages for single response
- Add SIGUSR2 signal handler to restart the process

## 0.4.4

### Patch Changes

- add used model info

## 0.4.3

### Patch Changes

- fix: truncate autocomplete choices to 100 chars in resume and add-project commands to avoid DiscordAPIError[50035]
- fix: filter out autocomplete choices in session command that exceed Discord's 100 char value limit

## 0.4.2

### Patch Changes

- Revert 0.4.1 changes that caused multiple event listeners to accumulate

## 0.4.1

### Patch Changes

- Separate abort controllers for event subscription and prompt requests (reverted in 0.4.2)

## 0.4.0

### Minor Changes

- hide the too many params in discord

## 0.3.2

### Patch Changes

- support DOMException from undici in isAbortError

## 0.3.1

### Patch Changes

- display custom tool calls in Discord with tool name and colon-delimited key-value fields
- add special handling for webfetch tool to display URL without protocol
- truncate field values at 100 chars with unicode ellipsis

## 0.3.0

### Minor Changes

- Fix abort errors after 5 mins. DIsable permissions.

## 0.2.1

### Patch Changes

- fix fetch timeout. restore voice channels

## 0.2.0

### Minor Changes

- simpler onboarding. do not ask for server id

## 0.1.6

### Patch Changes

- Check for OpenCode CLI availability at startup and offer to install it if missing
- Automatically install OpenCode using the official install script when user confirms
- Set OPENCODE_PATH environment variable for the current session after installation
- Use the discovered OpenCode path for all subsequent spawn commands

## 0.1.5

### Patch Changes

- Store database in homedir

## 0.1.5

### Patch Changes

- Move database file to ~/.kimaki/ directory for better organization
- Database is now stored as ~/.kimaki/discord-sessions.db

## 0.1.4

### Patch Changes

- Store gemini api key in database

## 2025-09-25

- Switch audio transcription from OpenAI to Gemini for unified API usage
- Store Gemini API key in database for both voice channels and audio transcription
- Remove OpenAI API key requirement and dependency
- Update CLI to only prompt for Gemini API key with clearer messaging

## 0.1.3

### Patch Changes

- Nicer onboarding

## 0.1.2

### Patch Changes

- fix entrypoint bin.sh

## 0.1.1

### Patch Changes

- fix woring getClient call

## 0.1.0

### Minor Changes

- init

## 2025-09-24 09:20

- Add comprehensive error handling to prevent process crashes from corrupted audio data
- Add error handlers to prism-media opus decoder to catch "The compressed data passed is corrupted" errors
- Add error handlers to all stream components in voice pipeline (audioStream, downsampleTransform, framer)
- Add error handling in genai-worker for resampler, opus encoder, and audio log streams
- Add write callbacks with error handling for stream writes
- Add global uncaughtException and unhandledRejection handlers in worker thread
- Prevent Discord browser clients' corrupted opus packets from crashing the bot

## 2025-09-23 14:15

- Update PCM audio logging to only activate when DEBUG environment variable is set
- Extract audio stream creation into `createAudioLogStreams` helper function
- Use optional chaining for stream writes to handle missing streams gracefully
- Simplify cleanup logic with optional chaining

## 2025-09-23 14:00

- Add PCM audio logging for Discord voice chats
- Audio streams for both user input and assistant output saved to files
- Files saved in `discord-audio-logs/<guild_id>/<channel_id>/` directory structure
- Format: 16kHz mono s16le PCM with FFmpeg-compatible naming convention
- Automatic cleanup when voice sessions end
- Add documentation for audio file playback and conversion

## 2025-09-22 12:05

- Fix event listener leak warning by removing existing 'start' listeners on receiver.speaking before adding new ones
- Add { once: true } option to abort signal event listener to prevent accumulation
- Stop existing voice streamer and GenAI session before creating new ones in setupVoiceHandling
- Prevent max event listeners warning when voice connections are re-established

## 2025-09-22 11:45

- Replace AudioPlayer/AudioResource with direct voice streaming implementation
- Create `directVoiceStreaming.ts` module that uses VoiceConnection's low-level APIs
- Implement custom 20ms timer cycle for Opus packet scheduling
- Handle packet queueing, silence frames, and speaking state directly
- Remove dependency on discord.js audio player abstraction for continuous streaming

## 2025-09-22 10:15

- Add tool support to `startGenAiSession` function
- Import `aiToolToCallableTool` from liveapi package
- Convert AI SDK tools to GenAI CallableTools format
- Handle tool calls and send tool responses back to session

## 2025-09-21

- Add `/resume` slash command for resuming existing OpenCode sessions
- Implement autocomplete for session selection showing title and last updated time
- Create new Discord thread when resuming a session
- Fetch and render all previous messages from the resumed session
- Store thread-session associations in SQLite database
- Reuse existing part-message mapping logic for resumed sessions
- Add session-utils module with tests for fetching and processing session messages
- Add `register-commands` script for standalone command registration

## 2025-01-25 01:30

- Add prompt when existing channels are connected to ask if user wants to add new channels or start server immediately
- Skip project selection flow when user chooses to start with existing channels only
- Improve user experience by not forcing channel creation when channels already exist

## 2025-01-25 01:15

- Convert `processVoiceAttachment` to use object arguments for better API design
- Add project file tree context to voice transcription prompts using `git ls-files | tree --fromfile`
- Include file structure in transcription prompt to improve accuracy for file name references
- Add 2-second timeout for thread name updates to handle rate limiting gracefully

## 2025-01-25 01:00

- Refactor message handling to eliminate duplicate code between threads and channels
- Extract voice transcription logic into `processVoiceAttachment` helper function
- Simplify project directory extraction and validation
- Remove unnecessary conditional branches and streamline control flow
- Update thread name with transcribed content after voice message transcription completes

## 2025-01-25 00:30

- Add voice message handling to Discord bot
- Transcribe audio attachments using OpenAI Whisper before processing
- Transform voice messages to text and reuse existing text message handler
- Support all audio/\* content types from Discord attachments

## 2025-01-25 00:15

- Update todowrite rendering to use unicode characters (□ ◈ ☑ ☒) instead of text symbols
- Remove code block wrapping for todowrite output for cleaner display

## 2025-01-24 23:30

- Add voice transcription functionality with OpenAI Whisper
- Export `transcribeAudio` and `transcribeAudioWithOptions` functions from new voice.ts module
- Support multiple audio input formats: Buffer, Uint8Array, ArrayBuffer, and base64 string

## 2025-01-24 21:10

- Refactor typing to be local to each session (not global)
- Define typing function inside event handler as a simple local function
- Start typing on step-start events
- Continue typing between parts and steps as needed
- Stop typing when session ends via cleanup
- Remove all thinking message code

## 2025-01-24 19:50

- Changed abort controller mapping from directory-based to session-based to properly handle multiple concurrent sessions per directory
