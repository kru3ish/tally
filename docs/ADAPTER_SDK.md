# Adapter SDK

An adapter teaches Tally one coding agent. It is one object in `src/agents/index.ts`, about 60 lines, and it has to do four things: name the agent's lifecycle events, reshape its payloads, shape Tally's answers back, and say where its hook file lives. Everything downstream (Task Contract, Judge, Assurance, Coach, receipts) consumes the normalised stream and never sees the agent.

## The contract

```ts
interface AgentAdapter {
  id: AgentId;                 // 'claude-code' | 'codex' | 'gemini' | 'cursor' | your id
  label: string;               // shown to users
  sessionEnv?: string;         // env var the agent sets with the session id in child processes, if any
  subscribed: string[];        // the agent's event names Tally installs hooks for

  event(name: string): CanonicalEvent;                              // agent event → Tally event
  normalize(raw: Record<string, unknown>, agentEvent: string): CanonicalInput;   // stdin JSON → Tally's input shape
  output(out: CanonicalOutput): unknown;                            // Tally's answer → agent's stdout JSON

  hooksFile(): string;                                              // user-scope hook file
  writeHooks(existing: unknown, command: (e: CanonicalEvent) => string): unknown;   // merge Tally's hooks into that document
  removeHooks(existing: unknown): unknown;                          // remove only Tally's entries

  transcriptRoots?: () => string[];                                 // where the agent keeps transcripts, if it does
  capabilities(): AgentCapabilities;                                // what this agent can and cannot tell Tally
}
```

Canonical events are Claude Code's hook names: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `PreCompact`, `Notification`, `SessionEnd`. Canonical input is Claude Code's hook input: `session_id`, `cwd`, `transcript_path`, `tool_name`, `tool_input`, `tool_response`, `prompt`, `last_assistant_message`, `stop_hook_active`. Tool names are `Bash` (with `tool_input.command`), `Read`, `Edit`, `Write` (with `tool_input.file_path`), and `mcp__<server>__<tool>` for MCP tools.

Canonical output is one of three things:

```ts
{ kind: 'context', event, text }   // extra context for the agent (Coach observations, last receipt, handoff)
{ kind: 'deny', reason }           // refuse a tool call (repo policy hard stop)
{ kind: 'block', reason }          // hold a Stop (definition-of-done gate)
```

Your `output()` translates these into whatever the agent reads. If the agent has no way to express one of them, return `null` for that kind and say so in `capabilities()`.

## Capabilities

Declare honestly. Tally renders "unavailable from this agent" for anything you mark false, and never estimates it.

```ts
interface AgentCapabilities {
  lifecycle_hooks: boolean;     // session start / end
  tool_calls: boolean;          // pre/post tool events with names and inputs
  shell_commands: boolean;      // the command text of shell tool calls
  file_reads: boolean;
  file_edits: boolean;
  permission_hooks: boolean;    // Tally can deny a tool call
  stop_hook: boolean;           // Tally can hold a stop (or send a follow-up message)
  context_events: boolean;      // compaction / context pressure
  subagents: boolean;
  transcript: boolean;          // Tally can read a transcript for prompts and tool calls
  token_usage: boolean;         // token counts per turn
  model_name: boolean;          // which model produced each turn
  cost: boolean;                // derivable from token usage and a price table
}
```

## How to add one

1. Read the agent's hook documentation and write down: the config file, the event names, the stdin fields, the stdout shape for denying and for adding context, and where transcripts live. Put what you verified, with the date, in `docs/PLATFORM_NOTES.md`.
2. Add the adapter object to `src/agents/index.ts` and register it in `ADAPTERS` and `AGENT_IDS`.
3. Map events with a `Record<string, CanonicalEvent>`. Map tool names to `Bash` / `Read` / `Edit` / `Write` in `normalize()`; keep unknown tools as they are.
4. Implement `writeHooks` / `removeHooks` for the agent's hook document. Tag every command Tally writes with `--agent <id>` so `removeHooks` can find its own entries and leave the user's alone. Look at the Gemini adapter for a matcher-array layout and Cursor for a flat one.
5. If the agent writes transcripts, add a parser in `src/transcript/` that returns a `Transcript` and dispatch on it in `parseTranscriptFile`. If it does not, say so in `capabilities()`; cost will read "unavailable from this agent".
6. Tests in `test/h15-agents.test.ts`: `normalize` for each event you map, `output` for each canonical kind, and a round trip through `dist/hook.js <event> --agent <id>` with a sample stdin, asserting the recorded events. Install and uninstall against a temp home, asserting the user's own hooks survive.
7. Document the agent in the README table and add a line to `CHANGELOG.md`.

Run `npm test`. The hook timing test (`test/m2-hooks.test.ts`) must stay green: adapters run on every event, so keep `normalize` free of I/O.

## What not to do

- Do not estimate tokens or cost from message lengths. Absent is honest; a made-up number is not.
- Do not branch on the agent anywhere outside `src/agents/` and `src/transcript/`. If you need to, the adapter is missing a mapping.
- Do not write into the user's repository from an adapter.
- Do not send anything to the network from a hook.
