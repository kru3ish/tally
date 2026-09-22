# Changelog

All notable changes to Tally. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver, and the plugin manifest version moves with the npm version.

## [0.1.1] - 2026-09-22

### Changed

- **Completion is measured over the criteria that could be checked.** An `unverifiable` criterion is a gap in the evidence, not a failure: completion % now uses only met / partial / unmet, the receipt shows the basis ("66.7% complete (1 unverifiable)"), and the verdict stays `borderline` whenever most criteria were unverifiable or none could be checked. Credited value is still computed over all criteria, so unverifiable work earns nothing. `tally judge <session> --recompute` re-derives a stored receipt under the new rule without a model call, and `tally calibrate report` now also shows verdict agreement within one step.
- **Effect on the author's 11 blind-graded sessions** (rescored, human grades unchanged): criteria unchanged at 51% exact / 63% within one step; verdicts within one step 7 → 9 of 11, exact 2 → 1 of 11. The remaining disagreements are ROI-driven (expensive sessions the author called worth it that Tally prices below their estimated value), which is the next target.
- **Quieter burn-rate rule.** Only 8 of 32 replayed suggestions were useful: it now needs $3 in 15 minutes over 10+ tool calls with no edit, at most once per 30 minutes.
- **Backfill spend cap is cumulative** across runs (last 24 h), and the projection prices tier 2 by session size ($0.15 + $0.004 per session dollar, capped at $3) instead of a flat $0.12.
- **Intake caps criteria at 8** (explicit first) and drops mechanical checks whose path cannot be a repo file; `.` or `*` means "any file changed". When commits are available they are weighted above the prompt wording for inferred tasks.

### Fixed

- Autopilot injected only pure observations; a note describing a file it had not written (HANDOFF.md) is now a status-line flag.
- The Coach's context-pressure maths used a 200k window on 1M-context models and reported values over 100%.
- A hook whose script had moved (a rebuild or update) failed silently on every event; `tally doctor` now flags it and `tally install` repoints it.

## [0.1.0] - 2026-09-16

First public preview. Installable as a Claude Code plugin (`/plugin marketplace add kru3ish/tally`, `/plugin install tally@tally`) and as an npm CLI (`npm i -g @kru3ish/tally`, binaries `tally` and `cc-tally`).

### Added

- **Receipts per task.** Intake freezes a ticket's acceptance criteria (GitHub, Jira, Linear, a `.md` file, or plain text), the Judge collects evidence from git and the transcript, re-runs the project's tests itself, rates each criterion met / partial / unmet / unverifiable with cited evidence, and computes completion, cost by phase and by model, waste in dollars, value, ROI and a deterministic verdict.
- **Tiered judging.** Mechanical checks first (no model), a small model on the rest with a trimmed evidence pack, the strong model only for expensive sessions, `--deep`, or criteria the small model was unsure about. An escalation guard re-checks verdict-sensitive and correctness criteria. Self-overhead on the fixture receipts averages 4.1% of session spend.
- **Inferred tasks.** With no ticket linked, the task is inferred from the first prompts, the branch name and the session's commits, labelled `inferred task (unconfirmed)`; the Coach asks once for `[c]onfirm / [e]dit / [l]ink`, and `tally task --confirm | --edit "<text>" | --link <url>` does the same from the CLI. Reports and calibration break results down by task source.
- **Transcript-reconstructed diffs.** When a session left no commits, changes are reconstructed from the Edit / MultiEdit / Write calls and shell commands that write files, labelled `verified-against-disk` or `reconstructed` per file; tests only ever run against a real tree.
- **Autopilot and status line.** The Coach needs no pane: the Stop hook runs one pass per turn and its observations reach Claude on the next prompt; decisions only a human can make (confirm an inferred task, allow test re-runs, write a CLAUDE.md) become flags in a Claude Code status line that also shows the task, spend against budget and context use (`tally statusline`, `/tally:statusline`, installed by `tally install`). Each session opens with a one-line summary of the repo's last receipt.
- **Live Coach.** Thirteen deterministic rules (loops, re-reads, context pressure, CLAUDE.md, MCP opportunities and errors, dead-weight context, permission friction, burn rate, task quality, history lessons, test-rerun consent, task confirmation) plus an optional small-model pass once a session passes $1. One-key actions; notes reach Claude as observations (`Tally observed …`) under a `Tally:` prefix, never as instructions.
- **Follow-up.** Seven days after a receipt: merged, reverted, reopened, review churn, CI after merge; the verdict is adjusted and both are shown.
- **Experiments.** Alternate a skill or MCP server off and on across N tasks and compare completion, cost per criterion and rework between arms.
- **Backfill.** Receipts for sessions already in `~/.claude/projects`: task-link detection with confidence, git-window reconstruction, judging in a throwaway worktree, historical test re-runs with consent and offline dependencies only, ticket text as of session start, Coach replay, and blind grading with a per-grader calibration report.
- **Calibration harness.** Five fixture sessions with answers known by construction; CI replays the recorded model output and fails if agreement drops below the baseline or self-share exceeds 5%.
- **Packaging.** Self-contained `dist/cli.js` and `dist/hook.js` (esbuild, zod bundled, no runtime `node_modules`), exec-form plugin hooks (`node` + args, so Windows can spawn them), a self-hosted marketplace manifest, `claude plugin validate --strict` and a clean-install check on Linux, macOS and Windows in CI, a double-install guard (`tally install` refuses while the plugin is enabled; tool events are de-duplicated by `tool_use_id`; `tally doctor` reports both installs).
- **Privacy.** Everything local; hooks make no network calls and finish in under 150 ms; events are redacted and truncated before writing; write-back is opt-in and never includes prompts or code. See `SECURITY.md`.

### Known limitations

See the README's "Known limitations" section, including what was cut from this release (plugin evals, a data-dir migration to `${CLAUDE_PLUGIN_DATA}`).

[0.1.1]: https://github.com/kru3ish/tally/releases/tag/v0.1.1
[0.1.0]: https://github.com/kru3ish/tally/releases/tag/v0.1.0
