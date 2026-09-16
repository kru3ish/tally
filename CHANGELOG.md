# Changelog

All notable changes to Tally. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver, and the plugin manifest version moves with the npm version.

## [0.1.0] - 2026-09-16

First public preview. Installable as a Claude Code plugin (`/plugin marketplace add kru3ish/tally`, `/plugin install tally@tally`) and as an npm CLI (`npm i -g @kru3ish/tally`, binaries `tally` and `cc-tally`).

### Added

- **Receipts per task.** Intake freezes a ticket's acceptance criteria (GitHub, Jira, Linear, a `.md` file, or plain text), the Judge collects evidence from git and the transcript, re-runs the project's tests itself, rates each criterion met / partial / unmet / unverifiable with cited evidence, and computes completion, cost by phase and by model, waste in dollars, value, ROI and a deterministic verdict.
- **Tiered judging.** Mechanical checks first (no model), a small model on the rest with a trimmed evidence pack, the strong model only for expensive sessions, `--deep`, or criteria the small model was unsure about. An escalation guard re-checks verdict-sensitive and correctness criteria. Self-overhead on the fixture receipts averages 4.1% of session spend.
- **Inferred tasks.** With no ticket linked, the task is inferred from the first prompts, the branch name and the session's commits, labelled `inferred task (unconfirmed)`; the Coach asks once for `[c]onfirm / [e]dit / [l]ink`, and `tally task --confirm | --edit "<text>" | --link <url>` does the same from the CLI. Reports and calibration break results down by task source.
- **Transcript-reconstructed diffs.** When a session left no commits, changes are reconstructed from the Edit / MultiEdit / Write calls and shell commands that write files, labelled `verified-against-disk` or `reconstructed` per file; tests only ever run against a real tree.
- **Live Coach.** Thirteen deterministic rules (loops, re-reads, context pressure, CLAUDE.md, MCP opportunities and errors, dead-weight context, permission friction, burn rate, task quality, history lessons, test-rerun consent, task confirmation) plus an optional small-model pass once a session passes $1. One-key actions; notes reach Claude as observations (`Tally observed …`) under a `Tally:` prefix, never as instructions.
- **Follow-up.** Seven days after a receipt: merged, reverted, reopened, review churn, CI after merge; the verdict is adjusted and both are shown.
- **Experiments.** Alternate a skill or MCP server off and on across N tasks and compare completion, cost per criterion and rework between arms.
- **Backfill.** Receipts for sessions already in `~/.claude/projects`: task-link detection with confidence, git-window reconstruction, judging in a throwaway worktree, historical test re-runs with consent and offline dependencies only, ticket text as of session start, Coach replay, and blind grading with a per-grader calibration report.
- **Calibration harness.** Five fixture sessions with answers known by construction; CI replays the recorded model output and fails if agreement drops below the baseline or self-share exceeds 5%.
- **Packaging.** Self-contained `dist/cli.js` and `dist/hook.js` (esbuild, zod bundled, no runtime `node_modules`), exec-form plugin hooks (`node` + args, so Windows can spawn them), a self-hosted marketplace manifest, `claude plugin validate --strict` and a clean-install check on Linux, macOS and Windows in CI, a double-install guard (`tally install` refuses while the plugin is enabled; tool events are de-duplicated by `tool_use_id`; `tally doctor` reports both installs).
- **Privacy.** Everything local; hooks make no network calls and finish in under 150 ms; events are redacted and truncated before writing; write-back is opt-in and never includes prompts or code. See `SECURITY.md`.

### Known limitations

See the README's "Known limitations" section, including what was cut from this release (plugin evals, a data-dir migration to `${CLAUDE_PLUGIN_DATA}`).

[0.1.0]: https://github.com/kru3ish/tally/releases/tag/v0.1.0
