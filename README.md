# Tally (preview)

**A receipt for every Claude Code task, and a coach that runs on its own.**

Cost tracking is solved (`/cost`, `/usage`, ccusage). Retrospective habit coaching is built in (`/insights`). What nobody gives you is a receipt for **one task**: the ticket's acceptance criteria frozen at intake, what actually shipped, what it cost, what was wasted, whether it held up after merge, and whether it was worth it. Tally's Judge writes that receipt. The Coach is the live feedback loop those receipts drive.

Everything runs locally. No server, no database, no API key: Tally talks to Claude through `claude -p` on your existing login.

This is a **preview** (v0.3.0): the pipeline is tested end to end on Linux, macOS and Windows, but the Judge has been calibrated against five authored sessions and a first handful of real ones, not a benchmark. Read [How accurate is the Judge?](#how-accurate-is-the-judge) before trusting a verdict.

## See it run

![tally demo: a recorded session replayed through the real hooks, the Coach, the Judge and a follow-up](docs/demo.svg)

That is the real output of `tally demo` (timing compressed; also in [`docs/demo.cast`](docs/demo.cast) for `asciinema play`). The demo replays a recorded session through the real hooks with a stubbed model, in a throwaway directory, and never touches your `~/.claude`.

## Install

Two ways; pick one. Both record the same events into `~/.tally` and can be removed without a trace.

**As a Claude Code plugin** (hooks plus `/tally:*` commands, no Node setup beyond what Claude Code already needs):

```
/plugin marketplace add kru3ish/tally
/plugin install tally@tally
```

Then `/tally:statusline` once, so the task, spend against budget, context and open Coach flags sit in Claude Code's status bar. The Coach itself needs nothing: it runs after every turn (autopilot) and hands Claude its observations on the next prompt.

Optionally install the CLI for the one-key Coach pane, reports and backfill:

```bash
npm i -g @kru3ish/tally       # gives you `tally` (and `cc-tally`, the same binary)
tally doctor                  # checks claude, gh, hooks, pricing; must not say "installed 2 ways"
```

**As an npm CLI only** (hooks go into `~/.claude/settings.json`, backed up first):

```bash
npm i -g @kru3ish/tally
tally install                 # hooks + status line; refuses if the plugin is already enabled, so you never record twice
tally doctor
```

What each path gives you:

| | Plugin only | Plugin + CLI (`npm i -g @kru3ish/tally`) |
|---|---|---|
| Hooks record every session; receipts on push and at session end | yes | yes |
| Coach autopilot: rules run after every turn, observations reach Claude on the next prompt | yes | yes |
| Status line: task, spend vs budget, context %, open Coach flags (`/tally:statusline` or `tally install`) | yes | yes |
| `/tally:task`, `/tally:judge`, `/tally:report`, `/tally:tally` (status), `/tally:coach` (pending suggestions) | yes | yes |
| Optional one-key Coach pane (`tally watch`, `tally start`) | no, the slash command prints the install hint | yes |
| Receipts for past sessions (`tally backfill`) and blind grading (`tally calibrate`) | no | yes |
| Experiments, `tally undo`, `tally doctor`, `tally followup` on demand | no | yes |
| Evidence explorer, disputes, hard-stop approval (`/tally:explain`, `/tally:dispute`, `/tally:budget`) | yes | yes |
| Repo policy in `tally.json`: standing criteria, budget, hard stop | yes | yes |
| Playbook and numbers-only export (`tally playbook`, `tally export`) | no | yes |

Requirements: Node 18+, the Claude Code CLI (`claude`) on your PATH, `git`. `gh` is optional: GitHub issue intake works without it through the public REST API (set `GITHUB_TOKEN` for private repos); write-back and follow-up still need `gh`. Jira and Linear read `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `LINEAR_API_KEY` from the environment.

Uninstall: `/plugin uninstall tally` or `tally uninstall` (settings come back byte-identical, checked in CI), then `rm -rf ~/.tally` if you want the receipts gone too.

## Use it

```bash
claude                        # start Claude Code as usual; Tally is already running
```

Nothing else to start. After each of Claude's turns the hooks run the Coach once; anything it observes (a command failing three times, a file read three times, spend at 80% of budget, an MCP server erroring) is queued and reaches Claude as a `Tally:` line on your next prompt. Things only you can decide (confirm an inferred task, allow test re-runs, write a CLAUDE.md) are handed to Claude once as flags with the exact command, so Claude asks you in the conversation and runs it on your yes; they also show in the status line, `tally coach` lists them, `tally watch` acts on them with one key, and `tally config coach.autopilot false` turns autopilot off.

Paste a GitHub, Jira or Linear URL (or a `.md` path) in your first prompt and Tally links the task. With no ticket, Tally **infers** the task from your first prompts, the branch name and the commits you make, labels it `inferred task (unconfirmed)`, and the Coach asks once: `[c]onfirm  [e]dit  [l]ink`. From the CLI:

```bash
tally task https://github.com/acme/app/issues/42     # link a ticket
tally task --confirm                                  # keep the inferred criteria
tally task --edit "add rate limiting to login, with a test and a README note"
```

When Claude runs `git push` or `gh pr create`, the Judge runs in the background and the receipt lands in `~/.tally/sessions/<id>/report.md`. `tally judge` runs it on demand; `tally judge --post` also comments a compact receipt on the issue or PR. Seven days later, `tally followup` (or the next session start) checks whether it held up.

Inside Claude Code the plugin adds `/tally:task <ref>`, `/tally:judge [--post]`, `/tally:coach`, `/tally:report` and `/tally:tally` (status).

## For one person

The moment Tally is installed it reads the transcripts already on the machine and prints a one-page report with no model calls: total spend over the last 30 days, the three biggest sessions, where money bought nothing (retry loops, repeated reads, first-turn load, compactions), the one habit that would have saved the most, and what the same usage costs on each Claude plan at list price. `tally onboard` reprints it; `tally onboard --since 90d --json` feeds it to something else.

```bash
tally onboard                     # the 30-day report, from disk, no model
tally replay <session>            # the session as a timeline: prompts, first edits, first failing test, retry loops, context pressure, compactions, the receipt
tally prompts                     # what your best tasks' opening prompts had in common, and a template built from them
tally ask "which tasks cost the most per criterion this month?"   # a question over the receipts; numbers only leave the machine, answer cites sessions
tally export --invoice --out sept.md    # invoice lines: task, criteria met, independent test result, estimate, AI cost, verdict
```

`tally report` also shows estimate versus outcome by size bucket (≤ 1 h, 1–4 h, > 4 h): completion and cost per estimated hour, so you see where planning is consistently off. If the Coach or you leave a `HANDOFF.md` in the repo, the next session start hands its first lines to Claude as the state to resume from (files older than a day are ignored).

Inside Claude Code these are `/tally:onboard`, `/tally:replay`, `/tally:prompts` and `/tally:ask`.

## What a receipt looks like

```
Tally receipt · Rate limit the login endpoint
BORDERLINE  ·  66.7% complete (1 unverifiable)  ·  quality 7/10  ·  ROI 84.84×
  ✔ c1 POST /api/login returns 429 after 5 failed attempts from one IP within 15 minutes [tier2 1.00]
  ✔ c2 A test covers the 429 path [tier2 1.00]
  ✘ c3 README documents the limit [tier1 1.00]
  ? c4 Existing login behaviour is unchanged below the limit [tier1 1.00]
Judged by: tier 0 → tier 1 → tier 2 · tier 2 on 2 criteria: verdict-sensitive: c1, c2 · model spend $0.062
Verification: npm test → passed
Cost (API-equivalent): $1.33 / budget $56.25 (2.4%) · per met criterion $0.660 · waste $0.629
  Tally's own spend: $0.070 (5.3% of session spend, separate)
  by phase: explore $0.528, build $0.149, verify $0.604, ship $0.045  · subagents: agent-explore-01 $0.009
Value: 3h × $75 = $225, credited $113
Why: Two of the three verifiable criteria are met with an independent green test run, one is unmet and one
unverifiable, so 66.7% completion over what could be checked. Spend is well inside the budget and the ROI is comfortably above 2×, but the README
criterion was skipped and stated as skipped, and $0.60 of the $1.33 went into three identical failing test runs.
Next time:
  • When `npm test` fails twice with the same assertion, read the test before editing the implementation again.
  • Read the ticket checklist before saying done: the README item was explicit and skipped.
  • Stop calling the Jira MCP after the first 401; three retries burned three turns.

Follow-up 8 days later: PR #57 merged, then reverted in dba0f121  →  final verdict: NOT WORTH IT
```

The full `report.md` adds the evidence table, the waste breakdown (failed loops, repeated reads, dead-weight context, compaction churn, each in dollars), which files were `verified-against-disk` versus `reconstructed` from the transcript, and a skill/MCP attribution table labelled **correlational**, because it is.

## How the Judge works

1. **Intake** (one small-model call, cached): fetches the ticket via `gh`, the Jira REST API, the Linear API, a local `.md`, or plain text; freezes a checklist of acceptance criteria in `task.json` so the goalposts cannot move; scores spec quality 0–10 and lists the missing information; estimates human-hours (story points win when present) and sets a budget of 25% of the human-equivalent value.
2. **Evidence**: the git diff from the session-start HEAD, files changed, every test and lint command Claude ran with its result, ship events, and Claude's final messages. With no commits, the changes are reconstructed from the Edit / MultiEdit / Write calls and the shell commands that write files, and labelled as such.
3. **Independent verification**: Tally detects the project's test command (`package.json`, pytest, go, cargo, make, …) and runs it itself with a timeout, after asking once per repo. It never trusts "tests pass" in the transcript, and never runs tests against a reconstructed tree. Anything it cannot check is marked `unverifiable`, never guessed.
4. **Tiered judging**, so most receipts cost almost nothing:

| Tier | What runs | When |
|---|---|---|
| 0 | Mechanical checks the intake model attached to each criterion (`tests_pass`, `file_exists`, `file_changed`, `file_contains`, `diff_contains`, `command`, `pr`); cost, waste, ship events, test results | Always, no model |
| 1 | A small model (`models.tier1`, haiku) on the remaining `judgment` criteria, with an evidence pack trimmed to ~6k tokens; returns a confidence per criterion | Whenever judgment criteria remain |
| 2 | A stronger model on only the criteria that need it: the small model again under $1 of session spend, sonnet up to `judge.deepThreshold` ($3), opus above | Session cost ≥ $3, `--deep`, a tier-1 confidence below 0.6, a partial/unmet call on a correctness criterion, or a criterion whose one-step change would flip the verdict |

5. **Abstention**: when nothing could be checked, or most criteria were unverifiable, the verdict is `insufficient evidence` rather than a guess. `tally report` shows how often that happens.
6. **Numbers** are computed, not asked for: completion %, cost by phase, by subagent and by model, cost per met criterion, spend vs budget, waste in dollars, value = hours × `hourly_rate` credited at completion %, ROI, and a deterministic verdict (`worth it` needs ≥70% completion, ROI ≥2×, quality ≥6 and a green independent test run; `not worth it` is <40%, ROI <1 or quality <4).
7. **Follow-up** runs on the next session start after 7 days (or `tally followup`): PR merged or closed, reverted (git log), issue reopened, review comments and change requests, CI after merge. It stamps **held up / needed rework / reverted**, records the review burden (review rounds, hours from open to merge) and shows both the original and the adjusted verdict.

All dollar figures are **API-equivalent** at list price from `pricing.json` (with a `last_verified` date), since most people are on subscriptions. Tally's own calls are counted separately and shown on every receipt.

## Audit, dispute, policy

**See the evidence.** `tally judge <session> --explain c3` (or `/tally:explain c3`) prints the cited evidence line, the diff hunks for the files involved from the session's base commit, the independent test output, and the transcript moments that touched those files. A manager who sees "c3 unmet" can confirm in ten seconds that the README really was not touched.

**Disagree on the record.** `tally dispute <session> c3 --status met --reason "docs landed in the follow-up PR"` (or `/tally:dispute c3 met <reason>`). The receipt keeps the original status next to the override, is re-scored, says so on the report and in the PR brief, and the disagreement goes into the calibration log with its reason. Every dispute is a labelled data point about how your team reads "done".

**Repo policy.** A `tally.json` at the repo root, committed like any config:

```json
{
  "criteria": [
    { "text": "New code has tests", "check": { "kind": "tests_pass" } },
    { "text": "No changes under /billing without a CODEOWNERS review" }
  ],
  "budget": { "hourly_rate": 120, "fraction": 0.25, "hard_stop": true },
  "test_command": "npm run tests-only"
}
```

`test_command` is what the Judge runs for independent verification when the detected runner is wrong for the repo (a `pretest` step that needs the network or breaks on one platform, a monorepo, a suite that only works in CI). Standing criteria are appended to every task's frozen checklist (mechanical where a check is given, judged otherwise). The budget block sets the rate, the fraction of human-equivalent value, or a fixed `usd`. With `hard_stop`, once a session passes its budget the PreToolUse hook denies every tool call, the status line says `HARD STOP`, and a human lifts it with `tally budget approve --note "why"` (or `/tally:budget`), which is recorded on the receipt.

**Reviewer brief.** `tally judge --post` (or `writeback: true`) now posts a brief for the reviewer rather than a score: what was verified independently, what the model rated, what needs a manual look, where the agent struggled, and what was not verified against disk.

**Playbook and export.** `tally playbook` clusters the recurring "Next time" lessons across receipts and `--write` puts them in CLAUDE.md. `tally export --since 30d --out receipts.jsonl` writes one line per receipt with numbers, statuses and outcomes only, the record a platform team can collect centrally without collecting anyone's prompts or code.

## How accurate is the Judge?

Early, and measured two ways. Neither is a benchmark.

**Fixture regression (n = 5 sessions, 19 criteria).** Five authored sessions with answers known by construction (`test/fixtures/calibration/`) are judged live and compared with the authored grades. Last live run, 2026-09-16 with haiku as tier 1:

| Measure | Result |
|---|---|
| Criterion agreement (exact) | 19 / 19 |
| Verdict agreement | 5 / 5 |
| Criteria resolved mechanically, at $0 | 9 of 19 |
| Escalated to tier 2 | 7 criteria on 4 sessions (verdict-sensitive or correctness) |
| Tally's own spend, share of session spend | 2.1–5.1%, average 4.1% |

Across six live runs the same fixtures scored between 18/19 and 19/19; CI replays the recorded model output through the deterministic pipeline and fails if agreement drops below `baseline.json` or the self-share exceeds 5%.

**Real sessions, blind-graded (n = 11 sessions, 51 criteria, 1 grader(s), as of 2026-09-22; re-scored under 0.2.0's rules on 2026-09-23).** Backfilled receipts from the author's own repos, graded before seeing Tally's answer: criterion agreement 51% exact (61% within one step); the Judge abstains on 3 of 11 (insufficient evidence), and on the other 8 the verdict is exact on 1 and within one step on 6; Tally stricter on 14 of 51; Coach: 54 of 83 replayed suggestions marked useful (65%). Regenerate with `tally calibrate report --source backfill`, and add your own with `tally backfill add <session>` then `tally calibrate grade <session> --grader you`.

**Headless sessions, blind-graded by an independent model (n = 8 sessions, 50 criteria, 2026-09-26).** Eight small Node tasks (a slugify function, RFC 4180 CSV quoting, DELETE/PATCH on a todo API, a token bucket, env-override config loading, a CLI with `--top`/`--json`, a Markdown TOC generator, and one deliberately vague "make the logger better") were run as real `claude -p` sessions with Tally's hooks active, then graded from the repository alone by a separate Claude model that never saw Tally's receipt. Criterion agreement 49 of 50; verdicts 8 of 8. The one disagreement was a mechanical `diff_contains` pattern the intake model wrote too narrowly (`/spawn.*wc2/` against `spawnSync(process.execPath, [binPath, …])`), which is why a content-pattern miss is now a hint for the judgment tier rather than an `unmet`. This is a model grading a model on tasks written for the purpose: it shows the pipeline scores clean small tasks correctly, not that the Judge matches humans on messy real work; the 11-session human-graded number above is the one to watch. The task repos and runner are `tally-eval-setup.mjs` / `tally-eval-run.mjs` in the author's workspace, not shipped.

**Real open-source issues, blind-graded by an independent model (n = 6 sessions, 29 criteria, 2026-09-26).** Six open bug reports from public repositories (express #7350 and #4557, yargs #2423, qs #262, commander #2603, micromatch #212) were cloned locally, given acceptance criteria written from the issue text, and fixed by `claude -p` sessions under Tally (opus, 12 to 64 turns, $1.05 to $4.10 each, $15.14 in total). Nothing was pushed or posted upstream. A separate Claude model then graded each from the repository alone: criterion agreement 28 of 29; verdicts 4 of 6. Both verdict misses are the same kind: every criterion was met and the suite was green, and the grader still said *borderline* because the fix was a workaround for a bug that lives in a dependency (express #4557) or silently changed the meaning of patterns the suite never covered (micromatch #212). A criteria-and-tests Judge cannot see that, and the receipt does not claim to. Along the way the eval found and fixed five Tally bugs: the intake race at session end, two kinds of brittle intake-written checks (a pattern too narrow, a path that does not exist), a `command` check that ignored the repo's `test_command`, and GitHub intake requiring `gh`.

What those numbers say: on real sessions Tally and a human mostly agree on individual criteria and rarely on the exact verdict, but they are usually one step apart. The first grading pass scored 35% / 1 of 11; it exposed a bias in the mechanical checks (on sessions with no git tree they answered `unmet` against a repo that had moved on, where a human said `unverifiable`), and fixing that bias, not the grader, moved criteria to 51%. 0.1.1 then stopped counting unverifiable criteria as failures, which moved verdicts from 7 to 9 of 11 within one step (exact stayed at 1), and 0.2.0 made the Judge abstain on the 3 sessions where most criteria could not be checked instead of calling them borderline. What remains is value estimation: on four expensive sessions the author called worth it, Tally's ROI rule says the spend exceeded the task's estimated value. Until that is calibrated, read the criteria lines and treat the verdict as a second opinion.

Caveats: the fixtures are small JavaScript repos with one test file each; the small model's confidence is self-reported, so a confident wrong answer is only caught by the verdict-sensitivity and correctness guards; when a repo has no detectable test command, or you have not consented to re-runs, test criteria are `unverifiable` by rule; and on sessions with no commits the evidence is a transcript reconstruction, which the receipt says.

## What it costs you

Hooks: under 150 ms each, no network, exit 0 always (`tally doctor` measures the runtime). SessionEnd appends one event and spawns a detached process, well inside Claude Code's shared 1.5 s budget.

Model calls, per task, on the fixture sessions: intake ≈ $0.01 (cached on repeat), tier 1 ≈ $0.015, tier 2 ≈ $0.12 only above the deep threshold; the Coach's LLM pass runs at most every 90 s and only once a session has spent $1. Every receipt prints Tally's own spend and its share of the session; `tally doctor` warns when the running average passes 5%.

## The Coach

Autopilot by default: the Stop hook spawns one Coach pass per turn, observations are injected automatically, and human decisions become flags that Claude asks you about. The optional pane (`tally watch`) shows the same suggestions with one-key actions: `[a]pply`, `[i]nject`, `[s]kip`, `[m]ute rule`; an inferred task gets `[c]onfirm  [e]dit  [l]ink`. Injected notes reach Claude on its next turn as **observations** (`Tally: Tally observed npm test fail 3 times …`), never as instructions; what Claude does with them is up to Claude.

Rules are deterministic first, LLM second:

| Rule | Fires when | Action |
|---|---|---|
| loop-detect | the same failing command or edit repeats 3× | inject the observation |
| reread | the same file is read 3× | inject "keep notes" |
| context-pressure | context passes 70% / 85% | write `HANDOFF.md`, suggest `/compact` |
| claude-md | no CLAUDE.md, or an instruction is repeated | create / append CLAUDE.md |
| mcp-opportunity | 3+ shell or web fetches an MCP server would handle | show the `claude mcp add` snippet |
| dead-weight | a skill or MCP server is loaded but unused across recent sessions | measured or estimated first-turn overhead in dollars; points at `/plugin` Stats and "Not used recently" for the same list |
| mcp-errors | an MCP tool errors 3× | inject the observation |
| permission-friction | repeated prompts for the same safe command | allowlist entry, or `/fewer-permission-prompts` |
| burn-rate | spend with no file changes, or 80% / 100% of budget | inject a checkpoint |
| task-quality | no linked task, or spec quality < 5 | "Clarify the ticket first" + the questions |
| task-confirm | the task was inferred and not yet confirmed | confirm / edit / link |
| history-lesson | past receipts and follow-ups for this repo | inject at session start |
| verification-consent | the Judge wants to run your tests for the first time in this repo | allow / deny once |

Noise control: at most one non-critical suggestion per 3 minutes and 8 per session; critical ones always show. Suggestions rank by estimated dollars saved. Skip a rule 3 times and it mutes itself for that repo. `auto_apply` modes: `off`, `ask` (default), `auto`; `auto` may only write `.md` files, and `tally undo` reverses any change.

## Experiments, backfill, calibration

```bash
tally experiment start mcp jira --tasks 6          # alternate an item off/on across N tasks, compare arms
tally backfill list --since 60d                     # past sessions with cost and detected task link + confidence
tally backfill add <session> [--task <url|text>]    # receipt for a past session (worktree, consent, offline deps)
tally calibrate grade <session> --grader you        # blind: grade first, then see Tally's judgment
tally calibrate report --source backfill            # agreement, confusion, lean, inter-grader, Coach precision, by task source
```

Backfill finds the task link (URL in a prompt → issue key in the branch or commits → PR on the branch → inferred from the prompts), reconstructs the window from git, judges the diff in a throwaway `git worktree`, re-runs tests there only with consent and offline dependencies, runs follow-up, and replays the Coach rules into `coach_replay.json`. Sessions with no commits are judged from the transcript reconstruction, tests not run.

## What's stored where, and privacy

| Path | Contents |
|---|---|
| `~/.tally/sessions/<id>/events.jsonl` | hook events: prompts (truncated), tool names and inputs (truncated), results' first 600 chars, ship events; redacted before writing |
| `~/.tally/sessions/<id>/task.json`, `judge.json`, `report.md` | the frozen task and the receipt |
| `~/.tally/sessions/<id>/inject.jsonl`, `coach-state.json`, `seen.txt` | Coach notes queued for Claude, noise-control state, de-duplication keys |
| `~/.tally/history.jsonl` | one line per session and receipt: numbers, verdicts, recommendations, skills/MCP loaded and used. No prompts, no code |
| `~/.tally/calibration.jsonl`, `backfill/`, `experiments.json`, `mutes.json`, `undo.jsonl`, `tally-spend.jsonl` | your grades, the backfill index, experiments, muted rules, the undo log, Tally's own spend |
| `~/.tally/config.json`, `pricing.json`, `backups/` | config, an editable price table, and your settings files before Tally touched them |

Tally keeps its data in `~/.tally` rather than the plugin's data dir on purpose: receipts must outlive a plugin update or uninstall and be shared with the npm CLI. `TALLY_HOME` relocates it; `CLAUDE_CONFIG_DIR` relocates `~/.claude`. Tally reads Claude Code's transcripts in `~/.claude/projects/` for token usage and tool calls and never copies them.

- Everything is local. Hooks make no network calls.
- Tally's only outbound traffic is `claude -p` (your login, isolated from your MCP servers, hooks and skills), and, only when you ask, `gh` and the Jira/Linear APIs.
- **Air-gapped:** `tally config models.provider openai-compatible` points the Judge, Coach and intake at any OpenAI-compatible chat endpoint (`models.base_url`, default Ollama at `http://localhost:11434/v1`; key from the env var named by `models.api_key_env`). No traffic leaves the machine. Structured output is requested as JSON and parsed leniently, so a small local model works for the Coach and tier 1; calibrate before trusting a local model's verdicts (`tally calibrate grade`).
- Write-back is opt-in (`--post` or `writeback: true`) and carries the verdict, completion, cost and the criteria list. Never prompts or code.
- Test re-runs execute your project's test command with a scrubbed environment and a timeout, only after you consent once per repo.

Details, threat model and how to report a problem: [`SECURITY.md`](SECURITY.md).

## Compared with the built-ins and ccusage

| | ccusage / `/cost` / `/usage` | `/insights` | `/plugin` Stats | Tally |
|---|---|---|---|---|
| Unit | session, day, model | 30 days of sessions | plugin, skill, MCP | one task |
| Question | how much did I spend? | how do I work, what friction recurs? | what is loaded and used? | was this task done, at what cost, and was it worth it? |
| Ties spend to acceptance criteria | no | no | no | yes, frozen at intake |
| Independent verification | no | no | no | re-runs your tests |
| Post-merge outcome | no | no | no | merged / reverted / reopened / review churn |
| Live coaching | no | no | no | yes, one-key actions |
| Skill / MCP value | `/usage` attributes tokens | flags unused ones | "Not used recently" | dollars per session, plus controlled experiments |

Where a built-in already does the job, Tally points you to it: `/insights` for the retrospective, `/fewer-permission-prompts` for the allowlist, `/cost` and `/usage` for totals, `/plugin` Stats for what is loaded.

## Known limitations

- **Calibration is early and exact verdicts rarely match the author.** Five authored fixtures and 11 of the author's own sessions graded by one person: 51% exact criterion agreement; 3 abstentions, and on the rest verdicts 1 of 8 exact, 6 of 8 within one step. No external graders yet. Treat verdicts as a second opinion, read the criteria lines, and dispute what is wrong.
- **Cut from this release:** plugin evals (`claude plugin eval`, `evals/`), moving data into `${CLAUDE_PLUGIN_DATA}` (receipts stay in `~/.tally`), best-of-N model comparison on the same task, private eval suites from receipts, visual verification of UI tasks, and per-line human/AI attribution. Each is listed in DECISIONS.md with the reason.
- Sessions with no commits are judged from the transcript reconstruction; edits made by tools Tally does not parse (an MCP file server, an editor) are invisible, and tests are not run.
- Inferred tasks are only as good as the first prompts; confirm or edit them before trusting completion %.
- Dead-weight overhead is measured only when the repo has sessions both with and without the item; otherwise it is an even share, labelled estimated.
- Phase attribution (explore / build / verify / ship) is heuristic.
- Follow-up needs `gh`; Jira/Linear follow-up covers the linked issue only when a GitHub PR exists.
- Claude Code's transcript format is undocumented; the parser targets v2.1.x and `tally doctor` checks recent transcripts still parse.
- Installing the plugin makes Claude Code run `npm install` in the plugin cache (it does so for any plugin with a `package.json`), which pulls about 80 MB of Tally's dev tooling that the prebuilt `dist/` never uses. Slow the first time, otherwise harmless.
- Hooks in `~/.claude/settings.json` use the shell form (`node "<path>" Event`); the plugin uses the exec form. Both are recognised, but don't run both.

## Roadmap

- Real-session calibration with outside graders, and a published agreement table that updates per release.
- Plugin evals in CI.
- A maintainer-review tier: reads the diff for layer (is the fix where the bug lives), blast radius and untested surface before a library change can be `worth it`; both verdict misses in the real-issue eval were of that kind.
- Receipts as a PR check (GitHub Action) for teams.
- OTel cross-check on by default when Claude Code telemetry is enabled.

## Development

```bash
npm test            # typecheck, bundle with esbuild, then vitest (161 tests)
npm run build       # dist/cli.js + dist/hook.js, committed because the marketplace clones this repo
npm run fixtures    # regenerates test/fixtures/session-basic
```

`docs/PLATFORM_NOTES.md` records what was verified against the Claude Code docs and CLI. `DECISIONS.md` lists every judgment call. CI runs the suite, the demo, the calibration eval, `claude plugin validate --strict`, a committed-bundle check, and a clean install of the tarball in a fresh HOME on Linux, macOS and Windows.

MIT.
