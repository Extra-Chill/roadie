// The base system prompt for Roadie's Pi sessions (#51). Replaces Pi's own
// default (its tool list, guidelines and Pi docs pointers) so Roadie owns the
// prompt: this base, then Roadie's per-session prompt (appended by
// ./roadie-extension.ts), then the project's AGENTS.md files, like OpenCode
// sessions. Tool definitions reach the model through the API's tool list, so
// they are not repeated here.

export const ROADIE_PI_BASE_PROMPT = [
  'You are a coding agent working in the user\'s project through the tools you are given.',
  'Read files with the read tool, change them with edit or write, and run commands with bash.',
  'Be concise. Show file paths clearly when working with files.',
].join('\n')
