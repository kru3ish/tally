# Changelog

All notable changes to Tally. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver, and the plugin manifest version moves with the npm version.

## [0.3.1] - 2026-09-26

### Fixed

- **Session-end judging raced the task intake.** A session that ends within a minute or two of its first prompt (common in headless `claude -p` runs) was judged against the prompt while the intake spawned by that prompt was still freezing the task: receipts showed 1 criterion where the task had 5–8. Session end now waits for a running intake (`judge.intake_wait_ms`, default 3 min), and an intake that finishes after a receipt exists re-judges it. Found by running eight headless sessions under Tally.
- **A generic `npm test` command check defers to the policy `test_command`.** When `tally.json` names the test command, an intake-written `command: npm test` check means "the tests" and takes the independent run's result instead of running the script the policy said is wrong here.
- **A guessed file path is a hint, not a verdict.** A `file_contains` check whose file does not exist (the intake model wrote `test/` for a repo whose tests live in `tests/`) now goes to the judgment tier when the session has a diff; the Stop gate's quick checks report such a path as unknown instead of holding the agent on it.
- **A content-pattern miss is a hint, not a verdict.** `diff_contains` and `file_contains` checks whose pattern does not match now send the criterion to the judgment tier with the miss noted, instead of resolving it `unmet` at tier 0, when the checked file was worked on in the session (or, for a diff pattern, the diff is non-empty). A pattern miss on a file the session never touched stays `unmet`; existence, diff-membership and test checks remain conclusive. The eval's one disagreement was such a pattern.
- Security watch: `.env` matches only as a path (not `process.env.X`); writes are flagged only when they leave the home directory or target a dot path under it, and once per file.

### Added

- **Repo policy `test_command`.** `tally.json` can name the command the Judge runs for independent verification when the detected runner is wrong for the repo or the platform.
- **GitHub intake without `gh`.** Issue and PR links resolve through the public REST API when `gh` is missing or not logged in; `GITHUB_TOKEN` / `GH_TOKEN` is used when present.
- `scripts/grading-sheet.ts --sessions a1b2c3d4,…` limits the blind grading sheet to given sessions.
- Calibration entries: eight headless sessions blind-graded by an independent model, 50 of 50 criteria and 8 of 8 verdicts after the fixes above; six real open-source issues fixed under Tally and blind-graded, 28 of 29 criteria and 4 of 6 verdicts (README, "How accurate is the Judge?").

## [0.3.0] - 2026-09-23

The agent asks Tally before it says done; one person gets the numbers on day one; air-gapped runs.

### Added

- **MCP server.** `tally mcp` (plugin: registered automatically; CLI: `tally mcp --install`) exposes `tally_task`, `tally_unmet`, `tally_receipt` and `tally_flags` so Claude can check what is still unmet before claiming a task is done.
- **Definition-of-done Stop gate.** When the quick checks (file exists / contains / changed, diff contains) show an unmet criterion at Stop, the hook blocks once with the list (`coach.dod_gate`, cap `coach.dod_max_blocks`).
- **Live criteria ticks and usage limits in the status line.** `met/checked ✔` from the quick checks, and the 5-hour and 7-day limits from Claude Code's own status JSON; a rate-limit rule warns at 80% with the reset time and a burn-rate ETA.
- **Security watch.** Credential access, downloads piped into a shell, writes outside the repository and tool results that read like instructions to the agent become critical Coach notes and a `safety` section on the receipt.
- **`tally onboard`.** A one-page report from the transcripts already on disk, no model calls, also printed at the end of `tally install`: spend, biggest sessions, waste that bought nothing, one habit to change, and the plan comparison from `pricing.json` (list prices, dated).
- **`tally replay <session>`.** The session as a timeline with the off-track moments marked.
- **`tally prompts`.** What the best-scoring tasks' opening prompts had in common, best half against worst half, with a template.
- **`tally ask "<question>"`.** A question over the receipts, answered from the numbers-only export rows, citing sessions.
- **`tally export --invoice`.** Markdown or CSV invoice lines: task, criteria met, independent test, estimate, AI cost, verdict.
- **Estimate versus outcome** in `tally report`, by size bucket.
- **Local models.** `models.provider: openai-compatible` with `base_url`, `api_key_env` and optional per-million prices; Ollama, vLLM, LM Studio and llama.cpp server work.
- **Handoff resume.** A `HANDOFF.md` younger than a day is handed to Claude at SessionStart.

### Changed

- Security-watch flags are one per file, not per edit, and at most four per Coach pass.
- Plugin commands: `/tally:onboard`, `/tally:replay`, `/tally:prompts`, `/tally:ask`.

## [0.2.0] - 2026-09-23

Trust and control for teams, all local, no server.

### Added

- **Abstention.** A fourth verdict, `insufficient evidence`, when nothing could be checked or most criteria were unverifiable. The Judge says it does not know instead of guessing; `tally report` shows the abstention rate and `calibrate report` excludes abstentions from agreement.
- **Evidence explorer.** `tally judge <session> --explain <c1|all>` (plugin: `/tally:explain`) shows the cited evidence, the diff hunks for the files involved from the session's base commit, the independent test output, and the transcript moments that touched those files, with a dispute hint.
- **Dispute and override.** `tally dispute <session> <c2> --status met --reason "..."` (plugin: `/tally:dispute c2 met <reason>`) keeps the original status next to the override, re-scores the receipt, marks the change on the report and the PR brief, and logs a labelled disagreement to the calibration file (`--source dispute`).
- **Repo policy (`tally.json`).** Standing criteria appended to every task (checked mechanically where a check is given), a budget block (`hourly_rate`, `fraction`, fixed `usd`), and `hard_stop`: when spend passes the budget the PreToolUse hook denies every tool call with the reason until `tally budget approve --note "..."` (plugin: `/tally:budget`) records who lifted it and why. The status line shows the stop.
- **Reviewer brief.** The receipt posted on an issue or PR is now a brief for the human reviewer: verified independently, rated by the model, needs a manual look, where the agent struggled (loops and repeated reads), and what was not verified against disk.
- **Playbook.** `tally playbook [--all] [--write]` clusters the recurring "Next time" lessons across receipts and writes them as a CLAUDE.md section.
- **Review burden.** Follow-up records review rounds and hours from PR open to merge next to review comments and change requests.
- **Export.** `tally export [--since 30d] [--out f.jsonl] [--titles]` writes one JSON line per receipt with numbers, statuses and outcomes only (no prompts, code or criterion text; titles only on request): the record a team can collect centrally.

### Changed

- `judge --recompute` and `calibrate rescore` use the effective status (override over judge) and the current rule.
- Measured on the author's 11 blind-graded sessions: 3 abstentions; on the other 8, verdicts exact 1 of 8 and within one step 6 of 8; criteria 51% exact, 61% within one step.

## [0.1.1] - 2026-09-22

### Changed

- **Completion is measured over the criteria that could be checked.** An `unverifiable` criterion is a gap in the evidence, not a failure: completion % now uses only met / partial / unmet, the receipt shows the basis ("66.7% complete (1 unverifiable)"), and the verdict stays `borderline` whenever most criteria were unverifiable or none could be checked. Credited value is still computed over all criteria, so unverifiable work earns nothing. `tally judge <session> --recompute` re-derives a stored receipt under the new rule without a model call, and `tally calibrate report` now also shows verdict agreement within one step.
- **Effect on the author's 11 blind-graded sessions** (rescored, human grades unchanged): criteria unchanged at 51% exact / 63% within one step; verdicts within one step 7 → 9 of 11, exact 2 → 1 of 11. The remaining disagreements are ROI-driven (expensive sessions the author called worth it that Tally prices below their estimated value), which is the next target.
- **Flags go to Claude.** Decisions autopilot cannot make (consent, confirmation, a file to write) are handed to Claude once as an observation with the exact `coach --apply <rule>` command, so you decide in the conversation and Claude runs it; `tally coach` lists them with the same commands, and the status-line hint names the command that exists for your install.
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

[0.2.0]: https://github.com/kru3ish/tally/releases/tag/v0.2.0
[0.1.1]: https://github.com/kru3ish/tally/releases/tag/v0.1.1
[0.1.0]: https://github.com/kru3ish/tally/releases/tag/v0.1.0
