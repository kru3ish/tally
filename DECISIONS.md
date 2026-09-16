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
