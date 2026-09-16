# Platform notes (verified 2026-09-16)

Checked against `claude --version` = **2.1.268** and the official docs at code.claude.com/docs. Where these notes disagree with the build brief, the notes win.

## Hooks

- Event names Tally uses: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `PreCompact`, `Notification`, `SessionEnd`. (The full list is much longer: Setup, PermissionRequest, SubagentStart/Stop, PostCompact, etc.)
- Stdin JSON, common fields: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode`, plus `agent_id` / `agent_type` when inside a subagent. Verified live in a real transcript's hook attachment: `{"session_id","transcript_path","cwd","prompt_id","permission_mode","effort","hook_event_name","tool_name","tool_input",...}`.
- Event-specific fields: SessionStart `source` (`startup|resume|clear|compact|fork`) and optional `model`; UserPromptSubmit `prompt`; PreToolUse `tool_name`, `tool_input`, `tool_use_id`; PostToolUse adds `tool_response`; Stop `last_assistant_message`; PreCompact `trigger` (`manual|auto`); SessionEnd `reason`; Notification `notification_type` + `message` (matcher `permission_prompt`).
- `additionalContext` injection: print `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}` on stdout with exit 0. Supported on `UserPromptSubmit`, `SessionStart`, `Stop`, `PostToolUse`, `PostToolBatch`, `PostModelSwitch`. Plain-text stdout on UserPromptSubmit/SessionStart is also added as context.
- Async hooks: `"async": true` on a command hook runs it without blocking; output and exit code are not processed and the timeout is not enforced. `asyncRewake` wakes Claude on exit 2. Tally uses async for PreToolUse, PostToolUse, PostToolUseFailure, Stop, PreCompact, Notification and sync for SessionStart, UserPromptSubmit, SessionEnd (the ones that must return context or run before exit).
- Hook types: `command`, `http`, `mcp_tool`, `prompt`, `agent`. Config shape: `hooks.<Event>[] = { matcher?, hooks: [{ type, command, args?, timeout?, async?, shell?, if?, statusMessage? }] }`.
- Exit codes: 0 = success (JSON on stdout parsed); 2 = blocking error (stderr shown to Claude); other non-zero = non-blocking error shown in transcript. Tally always exits 0.
- Timeouts: command hooks default 600 s, lowered to 30 s on UserPromptSubmit. **SessionEnd hooks share a 1.5 s budget**, so Tally's SessionEnd hook only appends one event and spawns a detached `tally finalize`.
- Matchers: tool names for tool events (regex if it contains non-word characters), `startup|resume|clear|compact` for SessionStart, `permission_prompt` etc. for Notification.

## Plugins

- Layout: `.claude-plugin/plugin.json` (only `name` required; `hooks`, `commands`, `skills`, `agents`, `mcpServers` paths optional), `commands/*.md`, `skills/<name>/SKILL.md`, `hooks/hooks.json`, `.mcp.json`.
- `${CLAUDE_PLUGIN_ROOT}` expands to the plugin install dir; `${CLAUDE_PLUGIN_DATA}` is a persistent data dir; `${CLAUDE_PROJECT_DIR}` is the project root.
- Local install: `claude plugin marketplace add <dir>` (dir holds `.claude-plugin/marketplace.json` with `plugins[].source` relative paths) then `claude plugin install tally@tally`; or session-only `claude --plugin-dir <dir>`; or `claude plugin init` for a skills-dir plugin. `claude plugin validate <dir>` checks structure.
- Command files: markdown with frontmatter `description`, `argument-hint`, `allowed-tools`, `model`; `$ARGUMENTS` substitution; `` !`cmd` `` inline or a ```` ```! ```` block runs shell before the prompt is sent. Plugin commands are invoked as `/tally:<name>`.

## Settings, skills, MCP, headless

- Precedence (high to low): managed, `--settings` CLI, `.claude/settings.local.json`, `.claude/settings.json`, `~/.claude/settings.json`. `~/.claude.json` holds MCP servers (`mcpServers`, per-project `projects[cwd].mcpServers`), sign-in state, and global config; project MCP also lives in `.mcp.json`. `enabledPlugins` and `extraKnownMarketplaces` live in settings.json. `CLAUDE_CONFIG_DIR` relocates `~/.claude`.
- Permission rules: `Bash(npm test:*)` prefix form; `permissions.allow/deny/ask`. `disabledMcpjsonServers` / `enabledMcpjsonServers` toggle `.mcp.json` servers per project.
- Headless: `claude -p "<prompt>" --output-format json --json-schema '<schema>' --model <m> --system-prompt <s> --max-turns 1 --tools "" --no-session-persistence`. Output JSON: `result` (string), `structured_output` (object), `total_cost_usd`, `usage` (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation.ephemeral_1h/5m`), `modelUsage[model]` (`costUSD`, `contextWindow`, `canonicalModel`), `session_id`, `is_error`, `num_turns`.
- **Measured:** a plain `claude -p` from a normal cwd loaded 172k tokens of plugins/MCP/CLAUDE.md context and cost $0.35 for a one-line answer. Adding `--setting-sources "" --strict-mcp-config --tools ""` and running from an empty temp dir cut it to 7.3k tokens / $0.016. `--bare` is cheaper still but does not use subscription login (`Not logged in`), so Tally uses the isolation flags rather than `--bare`.

## Transcripts

- Location: `~/.claude/projects/<cwd with [:\\/.] replaced by ->/<session-id>.jsonl`. Sidecar dir `<session-id>/tool-results/` holds large tool outputs; `<session-id>/subagents/agent-*.jsonl` appears when subagents ran (older builds mark subagent lines inline with `isSidechain: true` + `agentId`). Tally handles both.
- Assistant lines: `type: "assistant"`, `message.model`, `message.id`, `message.usage` with `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation.ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens`. **One API response is written as several lines (one per content block) that repeat the same `message.id` and `usage`; Tally counts usage once per message id.**
- Tool results: `type: "user"` lines whose `message.content[]` holds `tool_result` blocks with `tool_use_id`, `content`, and `is_error`.
- Compaction: a `type: "user"` line with `isCompactSummary: true` (older: `system` line with `subtype: "compact_boundary"`).
- Context size at a point in time = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` of the latest main-thread assistant message. The model string can carry `[1m]` for the 1M context window.
- Retention: `cleanupPeriodDays` (default 30) deletes old transcripts; Tally copies nothing but reads them while they exist.

## Built-ins Tally points to instead of rebuilding

- `/cost` (API accounts) and `/usage`: session token totals and dollar estimate at list price; `/usage` also shows plan limits, attribution to skills/subagents/MCP servers, and behaviour flags on subscription plans.
- `/insights`: analyzes up to 200 recent sessions and writes `~/.claude/usage-data/report.html` with friction points and suggestions (the 30-day retrospective).
- `/fewer-permission-prompts`: scans transcripts for common read-only Bash/MCP calls and adds a prioritized allowlist to `.claude/settings.json`.
- `/context`: what is consuming the context window right now.
- `/compact [instructions]`: manual compaction.

## Pricing (verified 2026-09-16, platform.claude.com/docs/en/about-claude/pricing)

Per MTok: Fable 5.1 $10/$50 (cache read $0.25); Opus 5 / 4.8 / 4.7 / 4.6 / 4.5 $5/$25 (cache read $0.50, 5m write $6.25, 1h write $10); Sonnet 5 $2/$10; Sonnet 4.6/4.5 $3/$15; Haiku 4.5 $1/$5. 5m cache write = 1.25× input; 1h write = 2× input; cache read = 0.1× input (0.025× on Fable/Mythos 5.1). Stored in `pricing.json` with `last_verified`.

## Headless runs and transcripts (verified 2026-09-16, hardening pass)

- `claude -p … --no-session-persistence` from an empty temp dir wrote **no transcript**: only an empty `~/.claude/projects/<encoded-cwd>/memory/` directory appeared. The same call without `--no-session-persistence` (measured earlier with `--bare`) did write `<session>.jsonl`.
- Tally therefore relies on `--no-session-persistence` for its own calls, and additionally: runs from a cwd named `tally-llm-*`, sets `CLAUDE_CODE_ENTRYPOINT=tally` and `TALLY_INTERNAL=1`. The parser tags any transcript whose `cwd` contains `tally-llm-` or whose `entrypoint` is `tally` as `internal`; `finalize` never writes such sessions to `history.jsonl`, `loadHistory()` drops any entry marked `internal` or under such a cwd, and the Judge refuses to judge them. Dead-weight, trends and experiments all read through `loadHistory()`.
- Tally's hooks return immediately when `TALLY_INTERNAL=1` is in the environment (Claude Code passes its environment to hook processes), on top of `--setting-sources ""` which already skips hooks.
- Claude Code's own `/insights` and `/usage` are outside Tally's control; because no transcript is written they should not see these runs either. The empty `memory/` dirs are harmless clutter; `tally doctor` counts them.

## OpenTelemetry (optional cost cross-check)

- Claude Code exports metrics when `CLAUDE_CODE_ENABLE_TELEMETRY=1`: `claude_code.cost.usage` (USD, attributes `session.id`, `model`), `claude_code.token.usage` (attribute `type` = input | output | cacheRead | cacheCreation), plus lines-of-code, commits, PRs, sessions counters. Exporter selection: `OTEL_METRICS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`, interval `OTEL_METRIC_EXPORT_INTERVAL` (ms). Temporality: `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta` (Claude Code's default) so points can be summed.
- `tally otel` runs a loopback OTLP/HTTP JSON receiver, appends data points to `~/.tally/otel/metrics.jsonl`, and prints the variables above. The Judge sums `claude_code.cost.usage` for its session id and shows the total and the delta against the transcript-derived cost as a cross-check; the transcript stays the source for per-phase and per-subagent breakdowns because OTel carries no phase information.
- Not verified against a live export in this pass (it needs a real interactive session with telemetry enabled); the receiver and parser are tested against the documented OTLP JSON shape.


## Plugin packaging (verified 2026-09-16, release pass)

- `marketplace.json` (in `.claude-plugin/` at the repo root): required `name` (kebab-case, not one of the reserved names), `owner` (`name` required), `plugins[]` with `name` and `source`; optional `description`, `version`, `author`, `homepage`, `repository`, `license`, `displayName`. A relative-path source (`"./"`) loads the plugin from the same repo. Users add it with `/plugin marketplace add owner/repo` (optionally `@tag`) and install with `/plugin install <plugin>@<marketplace-name>`. `claude plugin validate .` warned that the marketplace had no `description`; `--strict` turns warnings into errors, so the release adds one.
- `claude plugin validate <path> [--strict]` checks required fields, types, unknown fields, frontmatter, and path traversal. `--strict` is in CI.
- `${CLAUDE_PLUGIN_ROOT}` is the install dir and changes on update; `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/<id>/`) persists across updates and is meant for installed dependencies and caches, and is deleted on uninstall from all scopes unless `--keep-data`. Tally keeps its receipts in `~/.tally` on purpose: they must outlive a plugin uninstall and be shared with the npm CLI, and `tally uninstall`/the README say how to delete them.
- Hooks: exec form is `"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/dist/hook.js", "Event"]`; each arg is passed verbatim with no shell. **Windows note:** exec form needs a real executable; `.cmd`/`.bat` shims cannot be spawned, so `node` + script path is the portable pattern (which Tally uses). `shell` is ignored when `args` is set. Plugin `hooks.json` allows `description` and `hooks` at the top level; `id` is not documented and would fail `--strict`.
- SessionEnd hooks share a 1.5 s budget (raised to a per-hook `timeout` if set, max 60 s); hooks over budget are cancelled. Tally's SessionEnd hook only appends one event and spawns a detached `tally finalize`, measured at 50–80 ms on Windows (test `h9-plugin`), and it does not wait for the child.
- `additionalContext` is plain contextual text, not an instruction; Tally's notes are phrased as observations with a `Tally:` prefix.
- Plugin `bin/`: executables there join the Bash tool's PATH for the session, but plugins distributed through claude.ai organization settings cannot ship a top-level `bin/`. Tally does not use it; the CLI comes from npm.
- `plugin.json` `version` pins updates: users get a new version only when the manifest version is bumped (local-directory marketplaces reload in place).
- `claude plugin eval <plugin>` runs cases from `evals/` (docs show JSON/Markdown cases with `userMessage` and `expectations`; the installed CLI's help mentions `<eval dir>/**/case.yaml`). Not exercised in this release (see CUT items).
