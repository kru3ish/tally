# Decisions

One line each. Newest at the bottom.

- D1: The working directory held an unrelated Python project (coach), so Tally lives in `~/dev/tally` as a fresh repo on `main`, per the global workspace convention.
- D2: Dependencies are `zod` at runtime and `typescript`, `vitest`, `tsx`, `@types/node` for dev. No CLI framework; args are parsed by hand.
- D3: `TALLY_HOME` overrides `~/.tally`; `CLAUDE_CONFIG_DIR` (Claude Code's own variable) overrides `~/.claude`. The demo and tests set both to temp dirs.
- D4: The hook entry (`dist/hooks/hook.js`) imports only node builtins plus `paths` and `redact`, so node startup dominates its runtime. Measured median is ~70 ms on Windows.
- D5: Two extra hooks beyond the brief's seven: `PostToolUseFailure` (failed Bash runs do not fire PostToolUse) and `Notification` with matcher `permission_prompt` (the only signal for permission friction).
- D6: PreToolUse, PostToolUse, PostToolUseFailure, Stop, PreCompact, Notification run `async: true`; SessionStart, UserPromptSubmit, SessionEnd stay sync because they return context or must run before exit.
- D7: Git HEAD at session start is read from `.git/HEAD` and refs files directly rather than shelling out, to stay inside 150 ms.
- D8: One API response spans several transcript lines with the same `message.id`; usage is counted once per id. Cache writes use the 1h price when `ephemeral_1h_input_tokens` is set, else 5m.
- D9: Phases are deterministic: `explore` until the first Edit/Write, `build` until the first test/lint command, `verify` until a ship command, then `ship`. Every assistant message is charged to the phase active when it was produced.
- D10: Waste dollar amounts: failed loop = cost of each repeat beyond the first; repeated read = cost of each read beyond the first; dead weight = (first-turn context − baseline 15k) priced as one 1h cache write plus a cache read per call; compaction churn = cache-write tokens of messages right after a compaction.
- D11: Tally's own LLM calls use `claude -p --setting-sources "" --strict-mcp-config --tools "" --max-turns 1 --no-session-persistence` from an empty temp dir. Measured: $0.016 per small call instead of $0.35 without isolation. `--bare` is not used because it rejects subscription logins.
- D12: The npm package root is also the plugin root (`.claude-plugin/plugin.json`, `hooks/hooks.json`, `commands/`), and `.claude-plugin/marketplace.json` points at `./`, so one clone serves `npm link`, `--plugin-dir`, and `plugin marketplace add`.
- D13: Uninstall restores the exact original bytes when the parsed settings equal the pre-install snapshot; otherwise it removes only Tally's hook entries and re-serializes with the file's own indentation.
- D14: Ship detection happens in the PostToolUse hook on Bash commands matching `git push`, `gh pr create|merge`, `npm|cargo publish`, `twine upload`, and spawns a detached `tally judge` process.
- D15: The `/insights`, `/fewer-permission-prompts`, `/cost`, `/usage`, `/context` built-ins are referenced by Coach messages, never reimplemented.
- D16: The budget is 25% of the human-equivalent value (hours × hourly_rate) with a $2 floor; one story point = 4 hours; without story points the intake model's hour estimate is used, else 2 hours.
- D17: Verdict is computed, not asked for: `worth it` needs completion ≥70%, ROI ≥2×, quality ≥6 and no failing independent run; `not worth it` when completion <40%, ROI <1× or quality <4; otherwise `borderline`. Completion counts met=1, partial=0.5, unmet and unverifiable=0.
- D18: Value credited = human value × completion %. ROI = credited value / session spend.
- D19: The Judge always uses its own skeptical system prompt; the model is configurable (`models.judge`, default opus) and may coincide with the session model.
- D20: Without a linked task the Judge still runs, with one inferred criterion from the first prompt and spec quality 0, and the report says so.
- D21: Skill/MCP "touched a met criterion" = the call happened in a user turn during which a file cited by a met criterion was edited. Labelled correlational everywhere it appears.
- D22: `tally judge --auto` on session end is skipped when a receipt already exists (a ship already judged it); a ship re-judges and keeps the previous receipt as judge.prev.json.
- D23: Coach noise state is per session (`coach-state.json`); mutes are per repo (`~/.tally/mutes.json`); three skips auto-mute.
- D24: Coach `auto` mode writes only `.md` files; `settings` actions (allowlist entries) only run when the user presses `[a]`; MCP and plugin removal is shown as a command, never executed.
- D25: Dead-weight overhead is the average first-turn context above the 15k baseline across the last N sessions in the repo, shared evenly across loaded items; the message says so and points to `tally experiment`.
- D26: Experiments patch `.claude/settings.local.json` for the next session (`permissions.deny: Skill(name)` for skills, `disabledMcpjsonServers`/`disabledMcpServers` for MCP) and restore the exact prior bytes (or absence) at session end via `tally finalize`. Arms alternate off/on; the assignment is recorded when the first prompt's `tally task --auto` runs.
- D27: Follow-up final verdict: reverted → not worth it; needed rework → one step down; held up → unchanged. Runs on session start when the last run is >24h old, for receipts 7–90 days old.
- D28: Follow-up's revert detection searches `git log --grep=revert` for the PR number, merge sha, or branch name.
- D29: `tally demo` isolates via TALLY_HOME and CLAUDE_CONFIG_DIR, feeds fixture events to the real hook binary, simulates time from event timestamps, and stubs every LLM call.
- D30: Fixture timestamps were stretched to a ~22-minute session so the Coach's 3-minute interval shows its behaviour in the demo.
- D31: Hook path is resolved from the package root (`dist/hooks/hook.js`) so tests running from `src/` and the CLI running from `dist/` agree.
- D32: On Windows the `claude` npm shim is resolved to its JS entry and run with node directly, avoiding cmd.exe quoting of JSON arguments; timeouts kill the whole process tree with taskkill.
