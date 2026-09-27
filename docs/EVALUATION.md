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

**Authored fixtures** (`test/fixtures/calibration/`, n = 5 sessions, 19 criteria). Small JavaScript repos with answers known by construction. Judged live and recorded; CI replays the recorded model output through the deterministic pipeline and fails if agreement drops below `baseline.json` or the average self-share exceeds 8%. Last live run 2026-09-26: 19/19 criteria, 5/5 verdicts, self-share 2.1–13.6%, average 6.1%.

**Author's real sessions, human-graded** (n = 11 sessions, 51 criteria, one grader). Backfilled receipts from the author's own repositories, graded before seeing Tally's answer. Criterion agreement 51% exact, 61% within one step; 3 abstentions; on the other 8, verdicts exact 1, within one step 6; Tally stricter on 14 of 51. The first pass scored 35%; the gain came from fixing a bias in the mechanical checks against repos with no git tree, not from re-grading.

**Headless task set** (n = 8 sessions, 50 criteria, 2026-09-26). Purpose-written small tasks run as real `claude -p` sessions under Tally and graded by an independent Claude model from the repository alone. 49/50 at grading time, 50/50 after a brittle-regex fix; 8/8 verdicts.

**Real open-source issues** (n = 6 sessions, 29 criteria, 2026-09-26). Open bugs from express, yargs, qs, commander and micromatch, fixed locally under Tally, graded blind by an independent model. 28/29 criteria, 4/6 verdicts. Both verdict misses met every criterion with a green suite and were still borderline to a reviewer (a workaround for a dependency bug; untested behaviour changes). This is what the maintainer-review tier and the SUPPORTED status exist for.

## Methodology and its limits

- Blind grading means the grader records statuses before Tally's are revealed (`tally calibrate grade`, `scripts/grading-sheet.ts`). Reveal files show both afterwards.
- The model-graded sets are a model grading a model. They show the pipeline scores clean tasks correctly; they do not show agreement with humans on messy work. The human-graded set is the one to watch, and it is small and from one person.
- Fixtures are recorded model output replayed deterministically. Live re-runs vary: across seven live runs the fixtures scored 17/19 to 19/19; the 17 came from the strong model disagreeing with the author on one criterion, which is why a pessimistic tier-1 quality score now confirms prose only and does not re-open statuses.
- Nothing here is a benchmark. Sample sizes are printed next to every figure on purpose.

## Reproduce

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
