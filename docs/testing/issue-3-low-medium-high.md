# Issue #3: Tally on low, medium and high projects

Tested on 2026-10-18 with Claude Code 2.1.302 and Tally 0.7.0 and 0.8.0 (run 1 on 0.7.0, runs 2 and 3 on the 0.8.0 build). Agent model: `sonnet` (Sonnet 5.5). Every session was a real headless run, `claude -p "Implement the story in STORY.md. Run the tests before you finish." --plugin-dir <tally>`, in its own git repo, with the story written as a Jira-style ticket in `STORY.md`.

| Tier | Story A | Story B (similar to A) | Starting repo |
|---|---|---|---|
| Low | STR-101 `slugify` helper + test | STR-102 `truncate` helper + test | one module, one test |
| Medium | TODO-201 due dates: CLI flag, validation, sorting, overdue filter, tests | TODO-202 priorities: CLI flag, validation, sorting, filter, tests | todo CLI: store, model, CLI, one test |
| High | DOC-301 Markdown→HTML converter, nine constructs, escaping, CLI, thorough tests, README | CFG-302 TOML-like config parser, nested arrays, line-numbered errors, CLI, thorough tests, README | empty |

The A stories ran first, then the B stories, so each B story had its A story as history. The work itself held up in every run: `npm test` passed in all 13 repos afterwards (2 / 5–6 / 16–22 tests for low / medium / high).

## Run 1 (0.7.0): found a bug

| Story | Estimate | Actual | Call |
|---|---|---|---|
| STR-101 | $0.25 (median of all sessions, nothing similar) | $0.14 | no estimate |
| TODO-201 | $0.14 (1 similar) | $0.17 | on target |
| DOC-301 | $0.14 (2 similar) | $0.20 | over |
| STR-102 | $0.17 (3 similar) | $0.14 | on target |
| TODO-202 | $0.14 (4 similar) | $0.16 | on target |
| CFG-302 | $0.16 (5 similar) | $0.23 | over |

Every neighbour had similarity 1.00. The prompt says "STORY.md." with a full stop after it, which Tally's path match did not accept, so the task was inferred from the prompt and the story was never read. All six sessions looked identical to the estimator, so a Markdown converter was priced from a slugify helper. The receipt's criteria also came from the prompt instead of the ticket.

**Fixed in 0.8.0:** a `.md` path followed by punctuation, quoted or in backticks is linked, and an inferred task's estimate reads the prompts and any `.md` they name. A regression test covers the exact prompt.

## Run 2 (0.8.0): fresh copies of the same six repos

| Story | Linked as | Closest past story (similarity) | Estimate | Actual | Call |
|---|---|---|---|---|---|
| STR-101 | file, 7 criteria | its run-1 twin (0.94) | $0.14 | $0.14 | on target |
| TODO-201 | file, 8 criteria | its run-1 twin (0.96) | $0.17 | $0.16 | on target |
| DOC-301 | file, 8 criteria | its run-1 twin (0.97) | $0.20 | $0.23 | over (+$0.03) |
| STR-102 | file, 7 criteria | run-1 twin (0.94), then STR-101 (0.59) | $0.14 | $0.14 | on target |
| TODO-202 | file, 8 criteria | run-1 twin (0.96), then TODO-201 (0.52) | $0.16 | $0.16 | on target |
| CFG-302 | file, 8 criteria | run-1 twin (0.97), then DOC-301 (0.26) | $0.23 | $0.21 | on target |

Each story's closest match is now the same story, and the next-closest is the same tier: low with low (0.59), medium with medium (0.52), while the two high stories are only 0.26 alike. Every estimate was within $0.03 of the actual cost. Each repo got its `.tally/ledger.jsonl` line at session end.

## Run 3 (0.8.0): OpenTelemetry the way an organisation would set it up

A fresh STR-101 repo with only `.claude/settings.json` → `env.OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_RESOURCE_ATTRIBUTES=team=platform,cost_center=eng-42`, and a local OTLP/HTTP collector. The first attempt (run 2, endpoint in the shell) sent nothing. Claude Code removes `OTEL_*` from the environment of hooks (checked directly: shell and settings `env` both stripped, other variables kept). Tally now reads those keys from Claude Code's settings files, managed settings included. With that, the collector received `tally.story.cost` 0.14, `.estimate` 0.14, `.overage` 0, `.avoidable` 0.06 and `.driver.cost` 0.06 (driver `context`), resource `service.name=tally, team=platform, cost_center=eng-42`.

## What the cost check found

The one driver in every session: about 13k tokens of tools loaded and never used (a plugin enabled globally on the test machine), $0.05–0.07 per story, about a third of each story's cost at this size. The fix is printed, not run: `claude plugin disable vercel`. No session retried a failing command or re-read files enough to count, and none compacted, which fits stories this size on Sonnet.

## The dashboard

`docs/dashboard.png` is `tally dashboard` over the combined ledger of all 13 stories, with CFG-302 (run 2) as the current story.

## Limits of this test

- One person, one machine, one model, 13 stories. Stories this size cost $0.12–0.23 on Sonnet 5.5, so low / medium / high differ by cents. A larger gap would need Opus or multi-hour stories.
- Run 2's estimates are easy because each story's twin had already run. This shows the matching works, not how well Tally estimates a story it has never seen; `tally estimate --backtest` is that measurement.
- The end-of-turn message in the UI was verified in an interactive session separately; headless runs do not show it.
- Tally's own model spend (intake, judge): $0.03 for run 1 and $0.04 for run 2.
