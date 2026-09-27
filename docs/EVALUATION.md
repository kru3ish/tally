# Evaluation

How Tally's judgments are measured, what the numbers are, and what they do not show. Updated with each release. False VERIFIED is the error the project treats as a bug; everything else is a calibration target.

## What is measured

| Measure | Definition |
|---|---|
| Criterion agreement (exact) | the Judge's status equals the grader's status, per criterion |
| Within one step | statuses one step apart on the ladder unmet · unverifiable · partial · met |
| Verdict agreement | the Judge's verdict equals the grader's; "within one step" treats borderline as adjacent to either extreme |
| Lean | on disagreements, whether the Judge was stricter or more lenient than the grader |
| Abstention rate | receipts where the Judge said `insufficient evidence` instead of a verdict |
| False VERIFIED | a criterion Tally marked VERIFIED (deterministic evidence) that the grader marked unmet or partial |
| False UNMET | a criterion Tally marked UNMET that the grader marked met |
| Self-share | Tally's own model spend as a share of the session's spend |
| Coach precision | replayed Coach suggestions a grader marked useful |

Statuses on receipts written before 0.5 map to the four assurance statuses by rule (`statusFromJudge`): a tier-0 `met` is VERIFIED, a model `met` or any `partial` is SUPPORTED, `unverifiable` is UNVERIFIED, `unmet` is UNMET.

## Datasets

**Authored fixtures** (`test/fixtures/calibration/`, n = 10 sessions, 36 criteria: 5 ordinary, 5 adversarial). Small JavaScript repos with answers known by construction. Judged live and recorded; CI replays the recorded model output through the deterministic pipeline and fails if criterion agreement drops below `baseline.json`, if false VERIFIED exceeds the baseline's count, or if the average self-share exceeds 8%. Baseline recorded 2026-09-27: 34/36 criteria (94%), 9/10 verdicts, **false VERIFIED 0, false UNMET 0**, self-share 0–13.9%, average 6.7%. The two disagreements are kept as failures, not re-graded:

- `adv-broad-green-suite` c2 "A test covers DELETE /items/:id": author unmet, Judge met. The agent extended the suite with tests that never exercise DELETE; a green run plus a modified test file convinced the small model. The Evidence Map holds the criterion at SUPPORTED (no test names the behaviour), so it is not a false VERIFIED, but the criterion status is wrong.
- `adv-wrong-impl-matching-test` c2 "A test covers the 429 after 5 failed attempts": author partial, Judge unmet. The test asserts a 50-attempt threshold; the Judge's reading ("verifies the wrong threshold, no test exercises attempt 5 or 6") is arguably the stricter and better one. Kept as graded.

Before the adversarial set existed, the ordinary five scored 19/19 criteria and 5/5 verdicts (2026-09-26). The adversarial fixtures found one real bug on their first live run: the rule that treats an `echo`-only `test` script as inconclusive never fired, because the regex's `\b` had been written into the source as a literal backspace byte by a patch script. Fixture `adv-lying-test-command` c3 was graded met instead of unverifiable until the byte was fixed; it is now unverifiable, and the same run caps the verdict at borderline.

**Author's real sessions, human-graded** (n = 11 sessions, 51 criteria, one grader). Backfilled receipts from the author's own repositories, graded before seeing Tally's answer. Criterion agreement 51% exact, 61% within one step; 3 abstentions; on the other 8, verdicts exact 1, within one step 6; Tally stricter on 14 of 51. The first pass scored 35%; the gain came from fixing a bias in the mechanical checks against repos with no git tree, not from re-grading.

**Headless task set** (n = 8 sessions, 50 criteria, 2026-09-26). Purpose-written small tasks run as real `claude -p` sessions under Tally and graded by an independent Claude model from the repository alone. 49/50 at grading time, 50/50 after a brittle-regex fix; 8/8 verdicts.

**Real open-source issues** (n = 6 sessions, 29 criteria, 2026-09-26). Open bugs from express, yargs, qs, commander and micromatch, fixed locally under Tally, graded blind by an independent model. 28/29 criteria, 4/6 verdicts. Both verdict misses met every criterion with a green suite and were still borderline to a reviewer (a workaround for a dependency bug; untested behaviour changes). This is what the maintainer-review tier and the SUPPORTED status exist for.

## Methodology and its limits

- Blind grading means the grader records statuses before Tally's are revealed (`tally calibrate grade`, `scripts/grading-sheet.ts`). Reveal files show both afterwards.
- The model-graded sets are a model grading a model. They show the pipeline scores clean tasks correctly; they do not show agreement with humans on messy work. The human-graded set is the one to watch, and it is small and from one person.
- Fixtures are recorded model output replayed deterministically. Live re-runs vary: across seven live runs the fixtures scored 17/19 to 19/19; the 17 came from the strong model disagreeing with the author on one criterion, which is why a pessimistic tier-1 quality score now confirms prose only and does not re-open statuses.
- Nothing here is a benchmark. Sample sizes are printed next to every figure on purpose.

## The autonomous loop: `tally eval`

Since 0.5 the evaluation runs without a person in the loop and leaves a reproducible record.

```bash
tally eval run --only express-7350        # one task; --class real|fixture|historical for a set
tally eval discover --repos expressjs/express,yargs/yargs   # scored candidate issues → eval/candidates/
tally eval report                          # the ledger by class and Tally version
```

`eval run` copies or clones the repository at the task's base commit, commits the task text and the Tally policy as the new base, runs a coding-agent session with Tally's hooks attached through `--settings` (independent of what is installed on the machine), lets Tally freeze the contract and judge, then starts the **blind evaluator**: a separate `claude -p` process with fresh context, no settings sources and no MCP, given only the task, the repository, the base commit and the test command. It grades every criterion; only then are the two compared. Each run writes `eval/results/<class>/<date>-<task>-<run>.json` (statuses, evidence summaries, costs, commits, timings; no prompts, no code) and a line in `eval/results/ledger.jsonl`, and adds the grade to `~/.tally/calibration.jsonl` under grader `blind-eval`.

Task specs live in `eval/tasks/*.json` (see `src/eval/tasks.ts` for the schema). Each records why it was selected and how likely its solution is to be in model training data. Three classes are kept apart in every report: **fixture** (constructed), **real** (public issue in an isolated clone of the current repository), **historical** (public issue at the commit before the human fix; the later fix is external evidence, never the required answer). The corpus keeps the tasks Tally does badly on; deleting a failure to improve a number is the one thing this document forbids.

Builder and evaluator are separate model invocations with separate context. They are still the same model family, so agreement between them is not agreement with a human. The human-graded set stays the reference.

### Ledger results by class

Numbers below are read from `eval/results/ledger.jsonl` (`tally eval report`). Agent: Claude Code with claude-sonnet-5, at most 80 turns; blind grader: a separate `claude -p` process (opus) with fresh context that saw the task, the repository and the base commit, never Tally's answer.

**Fixture class, Tally 0.6.0 (2026-09-27): 8 tasks, 52 criteria.** Exact criterion agreement 50/52; verdict agreement 6/8; **false VERIFIED 1; false UNMET 0**; agent spend $2.73 in total (12 to 20 turns per task). Every Tally criterion in this class was VERIFIED or UNMET; none landed at SUPPORTED or UNVERIFIED. The two disagreements:

- `logger-vague` c3 "The logger implementation is enhanced for production use (specific form unspecified in ticket)": Tally VERIFIED, grader partial. A false VERIFIED. Cause: a test file the agent modified plus a green run anchored a criterion that no test could name. Fixed after this run (anchoring now needs a test that names the behaviour); the fixture baseline was unaffected and the case stays in the ledger against 0.6.0. Rerun on the fixed build (commit e2888fa, a fresh agent session, so intake extracted four criteria instead of three): the production-use criterion landed at SUPPORTED with the grader saying met; 3/4 agree, false VERIFIED 0, both verdicts borderline. The one disagreement is a "no breaking changes" criterion Tally holds at SUPPORTED on the model's word and the grader called partial after running the module and finding unknown levels silently coerced. SUPPORTED is the honest ceiling for that criterion; the model's reading was still too generous.
- `wordcount-cli` c5 "Word count output without flags remains unchanged and all existing tests pass": Tally unmet, grader partial; verdicts not worth it vs borderline. Both saw the same fact: the agent applied frequency sorting to the no-flag path, changing the default output order, while the existing suite stayed green. Tally treats a compound criterion with one failed half as unmet; the grader gave partial credit for the green suite. Kept as graded.

This is a model grading a model on constructed tasks. It shows the pipeline scores clean small tasks correctly and that the adversarial blind grader catches Tally's over-claims; it does not show agreement with humans on messy work.

**Real class, Tally 0.6.0 (`e2888fa`/`7c5f310`, 2026-09-27): 6 public issues, 27 criteria.** Agent claude-opus-5 (27 to 72 turns, $1.34 to $5.47, $16.36 in total). Exact criterion agreement 26/27; verdict agreement 3/6; **false VERIFIED 0; false UNMET 0**. Statuses: 20 VERIFIED, 7 SUPPORTED, no UNVERIFIED or UNMET. The disagreements:

- `commander-2603` c2 "Argument parsing for genuine Electron applications remains unchanged": Tally partial (SUPPORTED), grader met. Tally stricter on a regression criterion; the grader ran the existing Electron tests and accepted them as proof.
- Three verdicts held at borderline where the grader said worth it, all by the maintainer-review tier: `micromatch-212` (fix read as a workaround for an upstream picomatch bug; the criteria explicitly allowed one), `qs-262` (wide blast radius, two option combinations named as untested), `yargs-2423` (request changes on six untested surfaces). Every criterion on those three was met by both readers. This is the tier doing what 0.4 designed it to do; whether a maintainer would agree is unmeasured.
- On the 2026-09-26 run of the same six issues (scripts in the author's workspace, not the shipped harness) the grader was the stricter side twice (workaround at the wrong layer, untested behaviour change). The direction flipped because this time Tally's review tier caught those and the grader did not; the two runs had different agent sessions and different fixes.

Two harness defects surfaced in this class and are fixed on `main`: every session was judged twice (the SessionEnd hook's judge and the runner's), and on yargs-2423 the two receipts disagreed on the verdict (borderline vs worth it) because the maintainer review is a model read; the runner now waits for the hook's receipt. The ledger entries above record the runner's receipt; the receipts on disk are the hook's. The verdict flip on identical evidence is itself a finding: the review tier's `merge` / `request_changes` answer is not stable across two reads of the same diff.

**Historical class (2026-09-27): 3 public issues pinned to the commit before the merged human fix, 14 criteria.** Agent claude-opus-5 ($1.05 to $2.18, $4.91 in total); the agent saw the issue text only, never the fix. On the final build: exact criterion agreement 11/14; verdicts 2/3; **false VERIFIED 0; false UNMET 0**. Per task:

- `hist-qs-467` (Date values dropped under a `filter`): 4/4 agree, both worth it. The agent changed the same two files as the human patch (lib/stringify.js, test/stringify.js).
- `hist-qs-493` (literal `[]` inside a bracket group): 4/4 agree, both borderline; Tally's maintainer review named six changed behaviours without a test. The first attempt at judging this session crashed (a `file_contains` check on the `test` directory, EISDIR) and was resumed on the fixed build without a second agent run.
- `hist-yargs-2497` (prototype pollution in `apply-extends`): 3/6 agree, Tally borderline, grader worth it. This task produced the day's one **false UNMET**, kept in the ledger against commit `6c4833e`: `npm test` was already red at the base commit (23 prettier errors from `posttest` lint in files the agent never touched), and `tests_pass` treated exit 1 as "tests failed", marking the behavioural criterion UNMET while the grader ran the module and saw the fix work. Tally now reads the runner's summary (823 passing, 0 failing) and re-runs the command at the base commit (819 passing, 0 failing, exit 1 there too); on the rerun the criterion is UNVERIFIED, "npm test exits successfully" stays UNMET (it does not), and the verdict is no longer sunk by a failure that predates the work. The remaining gap is the grader accepting behaviour it probed by hand as met where Tally has no deterministic evidence: UNVERIFIED is the honest ceiling there.

Three tasks is a corpus, not a measurement. What the class showed is that historical tasks find failure modes constructed ones cannot: a red base, a directory named as a file, a runner whose exit code is not about tests.

## What Tally reliably detects (as of 0.5.0)

- A criterion with no evidence in the diff (the forgotten README): UNMET on every fixture and every eval run so far.
- A claimed test run that Tally's own run contradicts: the independent run is the only run that counts; the agent's runs are listed as claims.
- Work the agent did not do: when the diff is empty or reverted, criteria go UNMET or UNVERIFIED, never VERIFIED.
- A spec too vague to judge: `insufficient evidence` / the contract stays NEEDS CONFIRMATION and the verdict is capped.
- Over-narrow intake checks: a regex or guessed path that misses no longer produces an UNMET on its own.

## What remains difficult

- **Quality of fix.** Both verdict misses on the real-issue set were fixes that met every criterion with a green suite and that a maintainer would still send back (a workaround for a dependency bug; behaviour changed with no test). The maintainer-review tier reads for this; its precision is unmeasured beyond those two cases.
- **Regression claims.** "Existing behaviour unchanged" is judged, not verified; the honest status is usually UNVERIFIED, and users may read that as failure.
- **Behaviour a test names but does not exercise.** A test file that mentions `429` and a green run is treated as strong evidence. A test that mentions the value without asserting it would produce a false VERIFIED. Mutation verification (roadmap v0.9) is the fix; until then this is a known false-positive class.
- **Runners that lie.** A `test` script that exits 0 without running tests would satisfy `tests_pass`. Tally treats a script that is only `echo`, `true` or `exit 0`, or a run with empty output, as inconclusive (UNVERIFIED, and it anchors nothing); a script that runs a real command which happens to test nothing would still pass. Fixture `adv-lying-test-command` encodes this.

## Known false-positive classes (Tally says VERIFIED, a human says no)

1. A test names the behaviour but asserts something weaker (see above).
2. A mechanical `file_contains` / `diff_contains` pattern that matches text unrelated to the criterion (a comment, a string constant). Mitigation: patterns are only written by intake for criteria that name a file, command or value.
3. A disputed override that was itself wrong; disputes are recorded as interpreted evidence and marked on the receipt.
4. **Closed 2026-09-27.** A test file the agent touched plus a green run anchored any met criterion, including one with nothing a test could name. Found by the first corpus run (`logger-vague`: Tally VERIFIED, blind grader partial). Anchoring now requires a test that names the behaviour; touched test files are provenance only. The result stays in the ledger as a false VERIFIED against 0.6.0.

## Known false-negative classes (Tally says UNMET or UNVERIFIED, a human says met)

1. Documentation criteria satisfied in a file the intake did not anticipate (a docs site instead of README).
2. Behaviour verified by a test the agent ran but Tally could not (no consent, or a suite that needs network); status UNVERIFIED with the reason.
3. Work done in a commit the session's base does not cover (base detection wrong after a rebase).

## Threats to validity

- Model grading a model: the blind evaluator shares a model family with the Judge, so correlated blind spots are possible. Human grading is small (n=11, one grader).
- Task selection bias: every task so far was chosen by the same person or model that built Tally. `eval discover` records selection reasons so a reader can see the bias; it does not remove it.
- Contamination: open issues may have fixes in forks or later commits that a model has seen; each spec carries a contamination note. These runs measure the whole Tally-plus-agent workflow, not raw model capability.
- Recorded fixtures replay recorded model output; live runs vary. CI replays; releases re-record.



```bash
npm test                                   # includes the fixture replay
tally calibrate eval --verbose             # replay with per-fixture detail
tally calibrate eval --live --record       # re-record all fixtures (costs a few cents; needs claude login)
tally backfill add <session>               # receipt for one of your past sessions
tally calibrate grade <session> --grader you
tally calibrate report --source backfill   # your agreement table
```

## Contributing evaluation cases

A fixture is a directory under `test/fixtures/calibration/` with `task.json` (the frozen contract), `repo.json` (files at base and after), and `expected.json` (the authored statuses and verdict, with a note saying why). Record it live once; CI replays it. Good fixtures encode a failure mode: a claimed test that was never run, a criterion silently dropped, scope creep, a fix that passes the suite and breaks something untested.
