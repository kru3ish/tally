# Tally

Per-task receipts and live coaching for Claude Code.

Cost tracking is solved (`/cost`, `/usage`, ccusage). Retrospective habit coaching is built in (`/insights`). What nobody gives you is a **receipt for one task**: the ticket's acceptance criteria frozen at intake, what actually shipped, what it cost, what was wasted, whether it held up after merge, and whether it was worth it. Tally's Judge writes that receipt. The Coach is the live feedback loop those receipts drive.

Everything runs locally. No server, no database, no API key (Tally talks to Claude through `claude -p` on your existing login).

## 60-second quickstart

```bash
git clone https://github.com/krishmehta/tally ~/dev/tally && cd ~/dev/tally
npm install && npm run build && npm link      # gives you the `tally` command
tally install                                 # adds hooks to ~/.claude/settings.json (backed up first)
tally doctor                                  # checks claude, gh, hooks, pricing
```

Then, in any repo:

```bash
claude                                        # start Claude Code as usual
# in a second terminal (or `tally start` to open a tmux split):
tally watch                                   # the Coach attaches to the live session
```

Paste a GitHub, Jira, or Linear URL (or a `.md` path) in your first prompt and Tally links the task automatically. Or link it yourself:

```bash
tally task https://github.com/acme/app/issues/42
```

When Claude runs `git push` or `gh pr create`, the Judge runs in the background and the receipt lands in `~/.tally/sessions/<id>/report.md`. `tally judge` runs it on demand; `tally judge --post` also comments a compact receipt on the issue or PR.

Try it without a real session:

```bash
tally demo
```

It replays a recorded session end to end with a stubbed model, in a throwaway directory, and never touches your real `~/.claude`.

## What a receipt looks like

```
Tally receipt · Rate limit the login endpoint
BORDERLINE  →  after follow-up: NOT WORTH IT (reverted)  ·  50% complete  ·  quality 7/10  ·  ROI 84.84×
  ✔ c1 POST /api/login returns 429 after 5 failed attempts from one IP within 15 minutes
  ✔ c2 A test covers the 429 path
  ✘ c3 README documents the limit
  ? c4 Existing login behaviour is unchanged below the limit
Verification: npm test → passed
Cost (API-equivalent): $1.33 / budget $56.25 (2.4%) · per met criterion $0.660 · waste $0.629
  by phase: explore $0.528, build $0.149, verify $0.604, ship $0.045  · subagents: agent-explore-01 $0.009
Value: 3h × $75 = $225, credited $113
Why: Two of four criteria are met with an independent green test run, one is unmet and one unverifiable,
so 50% completion. Spend is well inside the budget and the ROI is comfortably above 2×, but the README
criterion was skipped and stated as skipped, and $0.60 of the $1.33 went into three identical failing test runs.
Next time:
  • When `npm test` fails twice with the same assertion, read the test before editing the implementation again.
  • Read the ticket checklist before saying done: the README item was explicit and skipped.
  • Stop calling the Jira MCP after the first 401; three retries burned three turns.
```

The full `report.md` adds the evidence table, the waste breakdown (failed loops, repeated reads, dead-weight context, compaction churn, each in dollars), and a skill/MCP attribution table labelled **correlational**, because it is.

## How the Judge works

1. **Intake** (one small-model call): fetches the ticket via `gh`, the Jira REST API, the Linear API, a local `.md`, or plain text; freezes a checklist of acceptance criteria in `task.json` so the goalposts cannot move; scores spec quality 0–10 and lists the missing information; estimates human-hours (story points win when present) and sets a budget of 25% of the human-equivalent value.
2. **Evidence**: the git diff from the session-start HEAD, files changed, every test and lint command Claude ran with its result, ship events, and Claude's final messages.
3. **Independent verification**: Tally detects the project's test command (`package.json`, pytest, go, cargo, make, …) and runs it itself with a timeout. It never trusts "tests pass" in the transcript. Anything it cannot check is marked `unverifiable`, never guessed.
4. **The judge model** (a strong model, with a skeptical system prompt that is not the one the working session used) rates each criterion met / partial / unmet / unverifiable with cited evidence, scores quality, and writes three recommendations.
5. **Numbers** are computed, not asked for: completion %, cost by phase, by subagent and by model, cost per met criterion, spend vs budget, waste in dollars, value = hours × `hourly_rate` credited at completion %, ROI, and a deterministic verdict (`worth it` needs ≥70% completion, ROI ≥2×, quality ≥6, and a green independent test run).
6. **Follow-up** runs on the next session start after 7 days (or `tally followup`): PR merged or closed, reverted (git log), issue reopened, review comments and change requests, CI after merge. It stamps a final status of **held up / needed rework / reverted** and shows both the original and the adjusted verdict.

All dollar figures are **API-equivalent** at list price from `pricing.json` (with a `last_verified` date), since most people are on subscriptions. Tally's own calls are counted separately.

## The Coach

A plain terminal pane (`tally watch`) beside Claude Code. Each suggestion has one-key actions: `[a]pply`, `[i]nject` (the note reaches Claude on its next turn, prefixed `[Tally]`), `[s]kip`, `[m]ute rule`.

Rules are deterministic first, LLM second (a small model, at most one call per 90 s):

| Rule | Fires when | Action |
|---|---|---|
| loop-detect | the same failing command or edit repeats 3× | inject "stop and diagnose" |
| reread | the same file is read 3× | inject "keep notes" |
| context-pressure | context passes 70% / 85% | write `HANDOFF.md`, suggest `/compact` |
| claude-md | no CLAUDE.md, or an instruction is repeated | create / append CLAUDE.md (mentions `/insights`) |
| mcp-opportunity | 3+ shell or web fetches an MCP server would handle | show the `claude mcp add` snippet |
| dead-weight | a skill or MCP server is loaded but unused across recent sessions | show the removal command, with **measured** first-turn overhead |
| mcp-errors | an MCP tool errors 3× | inject "stop calling it" |
| permission-friction | repeated prompts for the same safe command | allowlist entry, or `/fewer-permission-prompts` |
| burn-rate | spend with no file changes, or 80% / 100% of budget | inject a checkpoint |
| task-quality | no linked task, or spec quality < 5 | "Clarify the ticket first" + the questions |
| history-lesson | past receipts and follow-ups for this repo | inject at session start |

Noise control: at most one non-critical suggestion per 3 minutes and 8 per session; critical ones (a loop, 85% context, over budget) always show. Suggestions rank by estimated dollars saved. Skip a rule 3 times and it mutes itself for that repo.

`auto_apply` modes: `off`, `ask` (default), `auto`. `auto` may only write `.md` files (CLAUDE.md, HANDOFF.md, notes). Settings and MCP changes always require `ask`. Every change is logged; `tally undo` reverses it.

## Experiments: does this skill or MCP actually help?

```bash
tally experiment start mcp jira --tasks 6
tally experiment report
```

Tally alternates the item off and on across the next N tasks in the repo by patching `.claude/settings.local.json` before each session and restoring it byte-identically at session end. The report compares completion %, cost per criterion, and rework rate between the two arms and says **not enough data** until each arm has three judged tasks.

## Commands

```
tally install [--project]      add hooks (backs up settings first)     tally uninstall  (byte-identical restore)
tally doctor                   environment checks                       tally config [key value]
tally task <url|path|text>     link + freeze criteria                   tally judge [session] [--post]
tally followup [session]       post-merge truth                         tally report [--here|--days N]
tally start | tally watch      the Coach pane                           tally coach --once
tally undo [n]                 reverse Coach changes                    tally experiment start|report|stop
tally sessions | tally status  what Tally knows                         tally demo
```

Plugin form: the repo root is also a Claude Code plugin. `claude plugin marketplace add ~/dev/tally && claude plugin install tally@tally` (or `claude --plugin-dir ~/dev/tally` for one session) installs the same hooks plus `/tally:task`, `/tally:judge`, `/tally:coach`, `/tally:report`, `/tally:tally`. Use either the plugin or `tally install`, not both; `tally doctor` warns if events would be recorded twice.

Config lives in `~/.tally/config.json`: `hourly_rate` (75), `writeback` (false), `auto_apply` (ask), `models.judge` (opus), `models.coach` and `models.intake` (haiku), `context_window`, `baseline_context_tokens`, `coach.*` limits, `judge.test_timeout_ms`. Jira and Linear read `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `LINEAR_API_KEY` from the environment.

## What's stored where

| Path | Contents |
|---|---|
| `~/.tally/sessions/<id>/events.jsonl` | append-only hook events: prompts (truncated), tool names and inputs (truncated), results' first 600 chars, ship events. Secrets are redacted before writing. |
| `~/.tally/sessions/<id>/task.json` | the frozen task: source, criteria, spec quality, estimate, budget |
| `~/.tally/sessions/<id>/judge.json`, `report.md` | the receipt (schema-validated) and its markdown rendering |
| `~/.tally/sessions/<id>/inject.jsonl`, `coach-state.json` | Coach notes queued for Claude, and noise-control state |
| `~/.tally/history.jsonl` | one line per session and per receipt: numbers, verdicts, recommendations, skills/MCP loaded and used. No prompts, no code. |
| `~/.tally/experiments.json`, `mutes.json`, `undo.jsonl`, `tally-spend.jsonl` | experiments, muted rules per repo, the undo log, Tally's own LLM spend |
| `~/.tally/config.json`, `pricing.json` | your config and an editable copy of the price table |
| `~/.tally/backups/` | your settings files before `tally install` and before each experiment arm |

Tally reads Claude Code's transcripts in `~/.claude/projects/` for token usage and tool calls; it never copies them. `TALLY_HOME` relocates the data dir; `CLAUDE_CONFIG_DIR` (Claude Code's own variable) relocates `~/.claude`.

## Privacy

- Everything is local. Hooks make no network calls and finish in under 150 ms.
- Tally's only outbound traffic is `claude -p` (your existing Claude login), and, only when you ask, `gh` and the Jira/Linear APIs for intake, write-back, and follow-up.
- Write-back is opt-in (`--post` or `writeback: true`). The comment carries the verdict, completion, cost, and the criteria list. It never includes prompts or code.
- Hook events are redacted (API keys, tokens, bearer headers, passwords in URLs) and truncated before they are written.

## Compared with ccusage and /insights

| | ccusage / `/cost` / `/usage` | `/insights` | Tally |
|---|---|---|---|
| Unit | session, day, model | 30 days of sessions | one task |
| Question answered | how much did I spend? | how do I work, what friction recurs? | was this task done, at what cost, and was it worth it? |
| Ties spend to acceptance criteria | no | no | yes, frozen at intake |
| Independent verification | no | no | re-runs your tests |
| Post-merge outcome | no | no | merged / reverted / reopened / review churn |
| Live coaching | no | no | yes, with one-key actions |
| Skill / MCP value | `/usage` attributes tokens | flags unused ones | correlational table + controlled experiments |

Where a built-in already does the job, Tally points you to it: `/insights` for the 30-day retrospective, `/fewer-permission-prompts` for the allowlist, `/cost` and `/usage` for totals, `/context` for what fills the window.

## How accurate is Judge?

Measured, not promised. Five fixture sessions with answers known by construction (`test/fixtures/calibration/`: a complete feature, a partial rate limiter, a session that claims tests it never wrote, an off-by-one "fix" that fails its own regression test, and a scope-creeping rename) are judged by the real model and compared with the authored grades.

Last live run, 2026-09-16, judge model `claude-opus-5`, 19 criteria across 5 sessions:

| Measure | Result |
|---|---|
| Criterion agreement (exact) | 18 / 19 = 94.7% |
| Verdict agreement | 4 / 5 = 80% |
| Disagreement 1 | "Page 2 returns items 11–20": human `unmet`, judge `partial` (the fix returns 11–21; the judge credited the overlap) |
| Disagreement 2 | Verdict for the session that claimed unwritten tests: human `borderline`, judge `not worth it` (the model scored quality 2/10 for the false claim, which the verdict rule turns into `not worth it`) |

A previous run of the same five sessions scored 19/19 and 4/5, so expect ±1 criterion of run-to-run variance from the model. The recorded model outputs replay through the deterministic pipeline in CI (`tally calibrate eval`), which fails if agreement drops below `baseline.json`; `tally calibrate eval --live` re-measures the model itself.

Grade your own receipts to build a real sample:

```bash
tally calibrate add <session> --human met,partial,unmet,unverifiable --verdict borderline
tally calibrate report      # exact and within-one-step agreement, confusion matrix, disagreements with the judge's evidence
```

Caveats: five authored sessions are a smoke test, not a benchmark; the fixtures are small JavaScript repos with one test file; the judge sees a scrubbed diff and an independent test run, which is more than it gets when a repo has no detectable test command or the user has not consented to re-runs (then test criteria are `unverifiable` by rule, not by judgment).

## Development

```bash
npm test            # builds, then runs vitest (88 tests: hooks, parser, intake, judge, coach, follow-up, experiments, demo)
npm run fixtures    # regenerates test/fixtures/session-basic from scripts/gen-fixtures.ts
```

`docs/PLATFORM_NOTES.md` records what was verified against the Claude Code docs and CLI (v2.1.268). `DECISIONS.md` lists every judgment call.

## Known limitations

- Tested on Windows and Node 24; hooks and the demo run on macOS/Linux by design but have not been exercised there yet.
- Dead-weight overhead is measured per session (first-turn tokens above a baseline) and shared evenly across loaded items; per-item attribution needs an experiment.
- Phase attribution is heuristic (first edit, first test run, first push).
- Follow-up needs `gh`; Jira/Linear follow-up covers the linked issue only when a GitHub PR exists.
- Claude Code's transcript format is undocumented; the parser targets v2.1.x and dedupes streamed lines by message id.
