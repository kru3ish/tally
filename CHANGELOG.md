# Changelog

All notable changes to Tally. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver, and the plugin manifest version moves with the npm version.

## [Unreleased]

### Added

- **`tally feedback <c#> correct|wrong|unsure [--comment "..."]`** (plugin: `/tally:feedback c2 wrong <comment>`). Labels a criterion on the current receipt and stores the label next to the receipt in `feedback.jsonl`, with what Tally had said (judge status, Evidence Map status, which tier decided) so the entry stands on its own. A wrong VERIFIED is flagged as `false_verified`. `tally feedback` alone lists the receipt's criteria with their ids. Local only.
- **Wrong-verdict report: `tally feedback wrong <c#> --report [--out bug.json] [--include-comment] [--yes]`.** Builds a sanitized bundle (`tally.wrong-verdict.v1`): Tally version, platform, agent product and model family, the criterion's position and statuses, the kinds of evidence on its Evidence Map with pass/fail, receipt counts, which tiers ran, how the independent run went (ran, passed, inconclusive, tests green, base-commit result, summary counts, runner kind). Excluded by construction: source code, prompts, diffs, repository URL or name, file paths, environment variables, terminal output, criterion text, evidence text. The serialized payload is scanned for API keys, tokens, JWTs, private keys, passwords, emails, URLs, internal hostnames and absolute paths; a hit blocks the report and names what was found. The full payload is shown and must be confirmed; `--out` writes it to a file and opens nothing; opening a pre-filled GitHub issue (template "Wrong verdict") is a separate default-No question, and a false VERIFIED is titled and labelled `false-verified`.
- **One-time usefulness question.** After the fifth real verification (`tally verify` or a manual `tally judge`; demo sessions and Tally's own runs never count), once, only in an interactive terminal and never under CI: "Has Tally caught something you would otherwise have missed? [y/n/skip]". Never asked again after any answer, skip included. Stored locally in `usefulness.json`.
- Issue template "Wrong verdict" (`.github/ISSUE_TEMPLATE/wrong_verdict.md`).

### Changed

- **`tally demo` tells the whole story and cleans up.** A seventh step replays the adversarial fixture "a test that agrees with its own mistake" (the agent implemented 50 attempts where the task said 5, wrote a test asserting 50, and the suite is green), clearly labelled, with the author's grading next to Tally's receipt; the fixture ships in the package. Output wraps to the terminal width (60 to 100 columns, `--width` to force one) so a recording fits; the temp directory is removed at the end unless `--keep`.
- **`tally onboard` is an honest first result.** It now opens with what history supports, as counts: sessions found, with enough information to analyse, with an identifiable task (issue, ticket or PR in the prompts or commits), with partial retrospective verification possible (repository still present with commits from the window), unreconstructable (unparseable or empty transcript), and directory gone. Then at most three findings, each labelled high/medium/low with the reason for that confidence: a "tests pass" claim in the final message with no test runner in the transcript, the same failing command repeated, a task-linked session whose repository still holds the commits, a heavy first turn. It states that a retrospective check can say UNVERIFIED or UNMET and that VERIFIED needs a live session. Newest sessions first, a `--budget` in seconds (default 60) with progress on a TTY, and one next command at the end. Reads locally only; no model calls.
- **`tally doctor` is a self-service install and support check.** New checks: the installed version and location, whether `tally` on PATH is this install, whether npm has a newer version (skipped with `--offline`, under CI or `TALLY_OFFLINE=1`), which supported agents are on the machine (Claude Code, Codex CLI, Gemini CLI, Cursor), whether Tally's hooks are in each detected agent, and whether each agent's history is readable (with a transcript count). Every failed or warned check carries a `fix:` line with the command or link that resolves it. `--json` prints a `tally.doctor.v1` document for pasting into issues. Exit code is 1 only when a required check fails; optional integrations warn.

## [0.6.1] - 2026-09-27

### Added

- **Eval results preserve the work.** Each `eval/results/<class>/…json` now records the agent's run configuration (model, turn cap, timeout, permission mode, allowed tools, grader model), its commits, per-file line counts, and the patch itself in a `.patch` file next to the result (capped at 400 KB, lockfiles excluded), so a disagreement can be re-read against the diff after the worktree is gone.
- **`tally eval run --resume-root <dir> --resume-session <id>`.** Continues a run whose agent already finished from its worktree and session (judge, blind grader, ledger), so a crash after the paid agent session does not force a second one. Used to finish the two historical tasks whose judge had crashed.
- **Historical eval class.** Three specs pinned to the commit before a merged human fix (qs #467, qs #493, yargs #2497); the agent sees the issue text only, and the fix PR is recorded as `human_fix` for the record.

### Changed

- **A failed test command is attributed before it counts.** Tally now reads the runner's own summary (mocha, node:test, tap, jest, pytest) and, when the post-run fails, runs the same command once more at the session's base commit in a throwaway worktree (dependencies shared through a junction). Three outcomes: the tests were green and a later stage failed (lint, a coverage threshold, a `posttest` script) → `tests_pass` is UNVERIFIED with the counts on it and the verdict is not penalised; the base passes or fails with fewer failing tests → the failure is the work's, UNMET as before; the base fails with the same count → UNMET with both runs on the evidence line, because only the task says whether those were the tests the work was meant to fix. Found by the historical eval on yargs #2497, where `npm test` was already red at the base commit (23 prettier errors in files the agent never touched) and Tally marked the behavioural criterion UNMET while the blind grader, who ran the module, said met: a false UNMET. The receipt records `verification.summary`, `tests_green`, `at_base` and `failure_attributable`.

### Fixed

- **`tally verify <session>` from another directory re-judged against the wrong repository.** Run from a directory that is not the receipt's repository, verify compared that directory's HEAD with the receipt's, concluded the receipt was stale, re-judged the session in the wrong tree (no diff, tests "not run: no consent") and overwrote a good receipt; the Evidence Map also scanned that directory's test files for keywords ("test/h13-agent.test.ts mentions CLI" on a receipt about another project). Found while auditing an evaluation session's receipt. Verify now uses the repository recorded on the receipt, shows the stored receipt without re-judging when that repository no longer exists, and the Evidence Map scans a tree only if it contains the receipt's base commit.
- **A `file_contains` check on a directory crashed the judge.** Intake wrote `{ file_contains, path: "test" }` for "test cases added under test/"; the resolver read the directory as a file and the whole judge failed with EISDIR, so the session got no receipt (found by the historical eval on qs #493). The check now searches the files under the directory (node_modules and dot directories skipped, 400 files cap), and any check that throws becomes an unverifiable criterion carrying the error instead of aborting the receipt.
- **`tally eval run` judged every session twice.** The SessionEnd hook spawns Tally's own judge; the runner judged again as soon as the agent exited, so each session got two receipts thirty seconds apart, the ledger recorded the runner's and the disk kept the hook's. On yargs #2423 the two disagreed (borderline vs worth it) because the maintainer review is a model read. The runner now waits up to ten minutes for the hook's receipt and judges only if none arrives; the result notes which receipt it used.
- **Generic tokens are not "names".** JSON, CLI, API, HTTP verbs and similar acronyms no longer count as keywords a test can name a behaviour with; half the test files in a JavaScript repository mention JSON.
- **False VERIFIED from a touched test file.** A test file the agent added or modified, plus a green independent run, used to anchor any met criterion at VERIFIED, including one with nothing a test could name ("the logger is enhanced for production use"). The first corpus run of `tally eval run --class fixture` caught it: the blind grader said partial where Tally said VERIFIED. Anchoring now needs a test that names the behaviour (a hunk in a test file, or a test in the tree, mentioning what the criterion is about); a touched test file is provenance only. Fixture baseline unchanged (no fixture relied on the weak anchor).

## [0.6.0] - 2026-09-27

Verification is Tally's own job: an autonomous, blind evaluation loop, adversarial fixtures, and a release checklist that runs itself.

### Added

- **`tally eval run|discover|report`.** For each task spec in `eval/tasks/`: an isolated clone or copy at the base commit, the task and policy committed as the base, a coding-agent session with Tally's hooks attached through `--settings`, Tally's judge and Evidence Map, then a **blind evaluator** in a separate `claude -p` process with fresh context that never sees Tally's answer. Results (statuses, evidence summaries, costs, commits, timings; no prompts or code) go to `eval/results/<class>/…json` and `eval/results/ledger.jsonl`, and the grade to `calibration.jsonl` under grader `blind-eval`. `eval discover` scores open issues in public repos into candidate specs with the selection reasons recorded; `eval report` aggregates by class and Tally version and never prints one headline number. Fourteen specs ship for the local corpus (8 constructed, 6 public issues).
- **Adversarial fixtures.** Five new calibration fixtures encode the ways an assurance tool gets fooled: a test that asserts `true`, an implementation and a test that agree with each other and violate the task, a green suite that exercises none of the new behaviour, a `test` script that is `echo ok`, and an implementation written then reverted while the final message claims it. Expectations can set an `assurance_ceiling` (a met criterion with no test that names it may be SUPPORTED, never VERIFIED); anything above the ceiling counts as a false VERIFIED.
- **False VERIFIED as a gate.** `tally calibrate eval` prints false VERIFIED and false UNMET, fails when false VERIFIED exceeds the recorded baseline (`--max-false-verified`), and `--rebaseline` records a deliberately lower number when the fixture set itself changed. `tally calibrate report` shows the same counts for human and blind grades.
- **Inconclusive runs.** A `test` script that is only `echo`, `true` or `exit 0`, or a run with empty output, makes `tests_pass` UNVERIFIED, anchors no VERIFIED in the Evidence Map, holds the verdict at borderline ("exited 0 but ran no tests"), and is recorded on the receipt (`verification.inconclusive`) so a rescore keeps the cap.
- **A test claim needs a test.** A criterion about tests that the model grades met, with no test file added, modified or naming the behaviour, is UNVERIFIED in the Evidence Map rather than SUPPORTED.
- **Release checklist that executes** (`npm run release-check`): clean tree, build matches `dist/`, tests, `npm pack` + clean install in a fresh HOME (install, then doctor must be clean), plugin validate, install/uninstall byte-identical, demo, fixture baseline and false-VERIFIED gate, every stored receipt on the machine still loads and renders, README commands exist, versions agree, no secrets in fixtures or eval data, no leftover eval worktrees. `release-check:live` adds a live fixture run.
- `docs/EVALUATION.md` gains: the autonomous loop, what Tally reliably detects, what remains difficult, known false-positive and false-negative classes, threats to validity, and the adversarial-fixture results with both disagreements kept.

### Fixed

- The inconclusive-run rule never fired: the `\b` in its regex had been written into the source as a literal backspace byte. Found by the adversarial fixture `adv-lying-test-command` on its first live run (it graded a `test: echo ok` script as met).
- `tally calibrate eval --live --record` now keeps the first recording of a fixture that had none even when agreement is below the baseline; before, new fixtures could never be replayed until the whole set scored at least the old number.
- `tally calibrate eval --verbose` crashed when a fixture's session id differed from its directory name.
- Fixture count and baseline gates in the test suite cover the ten fixtures, and assert false VERIFIED is zero.

## [0.5.0] - 2026-09-27

Tally becomes the reliability layer for AI coding agents: evidence first, model judgment labelled, any agent.

### Added

- **Normalised event stream** (`src/core/events.ts`). Raw hook events and the transcript project into one vendor-neutral stream (`session_started`, `user_prompt`, `file_edit`, `command_finished`, `test_finished`, `model_usage`, …) with the agent and the model as separate identities and a pointer back to the raw line. Engines read the stream; adapters own the edges.
- **Task Contract** (`src/core/contract.ts`, `tally task --show`). The frozen definition of done as a first-class object: goal, acceptance criteria, constraints (now extracted at intake), verification commands, unknowns, a status (`NEEDS CONFIRMATION` / `CONFIRMED`) and the revision history; `--confirm` and `--edit` record revisions in `contract.json`.
- **Assurance Engine and `tally verify`** (`src/assurance/`). An Evidence Map per criterion: changed files, matching diff hunks, tests added or modified by the agent, tests in the tree that name the behaviour, the independent run, the agent's own runs (claims), the model's reading (labelled), disputes. Statuses VERIFIED / SUPPORTED / UNVERIFIED / UNMET, where a model's judgment alone reaches SUPPORTED at most. `--json` emits `tally.verify.v1`; `--ci` exits 1 on UNMET; `--deep` judges with the strong model first. The map is stored on every new receipt and derived by rule for old ones.
- **Test provenance.** Pre-existing test files at the session's base, test files and cases the agent added or modified, the independent run's passed count, and the agent's own test runs, on the receipt and in `tally verify`.
- **Adapter capabilities and `tally adapters`.** Every adapter declares what its agent can and cannot expose (tool calls, shell, reads, edits, deny, stop, context, subagents, transcript, tokens, model, cost); `tally adapters` shows detection, install state and capabilities, and receipts say "unavailable" instead of estimating.
- Docs: `ARCHITECTURE.md`, `CONTRIBUTING.md`, `docs/ROADMAP_RELIABILITY_LAYER.md`, `docs/ADAPTER_SDK.md`, `docs/EVALUATION.md`; README restructured around the five questions; `SECURITY.md` states exactly what leaves the machine and when.

### Changed

- **Receipt redesign.** The summary leads with the Evidence Map ("3/4 criteria have sufficient evidence"), names the agent and model, shows verification provenance and potentially avoidable work itemised, and places the verdict, quality and ROI last, labelled experimental. The markdown report gains an Assurance section with the evidence under each criterion.
- `tally demo` now shows `tally verify` on the session, then the forgotten README criterion being fixed and verification becoming complete.
- Scope: changed areas are compared against the contract only when the contract names files or areas.

## [0.4.0] - 2026-09-26

Tally for every coding agent, and a Judge that knows what criteria cannot see.

### Added

- **Other agents.** `tally install --agent codex|gemini|cursor` writes Tally's hooks into Codex CLI's `~/.codex/hooks.json`, Gemini CLI's `~/.gemini/settings.json` or Cursor's `~/.cursor/hooks.json` (backed up; `uninstall --agent` removes only Tally's entries). One hook binary with `--agent <id>` maps each agent's events and payloads onto Claude Code's vocabulary, normalises tool names (`run_shell_command`, `shell` → `Bash`; `apply_patch`, `replace` → `Edit`) and answers in each agent's dialect (permission deny, additional context, Cursor's `followup_message` for the definition-of-done gate). Session ids are also taken from `GEMINI_SESSION_ID`.
- **Codex CLI transcripts.** Rollouts under `~/.codex/sessions` are parsed for prompts, tool calls, outputs and token counts, so Codex receipts, `onboard` and `backfill` carry cost. OpenAI prices (gpt-5 family, gpt-4.1, o3, o4-mini, gpt-5.3-codex) added to `pricing.json` with codex aliases, verified 2026-09-26.

### Changed (the Judge, from the real-issue eval)

- **Maintainer review tier.** On library-shaped repos (a non-private package with an entry point, a crate, a Python package; `judge.maintainer_review: auto|on|off`) the strong model reads the diff as a maintainer: is the fix where the bug lives, what else does the touched code serve, what changed that no test exercises. A "would request changes" holds the verdict at borderline with the reason on the receipt; it never raises one. Both verdict misses in the real-issue eval were of this kind.
- **Regression claims need judgment.** A criterion like "existing behaviour unchanged" or "no regressions" no longer resolves from a green suite; it goes to the judgment tier with the instruction to name what changed that no test covers, or say unverifiable. "The suite still passes" stays mechanical: the run is the right evidence for that.
- **A vague spec caps the verdict.** When intake flagged the spec for clarification and nobody confirmed the task, `worth it` becomes `borderline` with the reason; `tally task --confirm` lifts it. The "make the logger better" session in the eval scored 100% and worth it on inferred criteria; it now reads borderline.
- **A lone small-model quality score cannot say "not worth it".** The tier-1 quality number is the weakest figure on the receipt (it rated the same fixture 3/10 twice where the author said borderline). Below 4 with a green run it now escalates to the strong model, whose score can decide; with a failed run it still counts. `quality.source` on the receipt says which tier produced the score.
- **Dead-weight context is setup cost, not waste.** The first-turn overhead of global CLAUDE.md, plugins and skills is paid on every session before any work; the receipt now reports it as setup cost and keeps waste for what the session itself did (loops, re-reads, compaction churn). On the one-minute eval sessions this was 75% of the old waste figure.
- `calibrate eval --record --only <fixture>` records that fixture's model output without rewriting the shared baseline.

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
