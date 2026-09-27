# Contributing to Tally

Tally is a local CLI and a hook script, written in TypeScript for Node 18+, with zero runtime dependencies (zod is bundled). Everything below runs offline; only `tally calibrate eval --live` calls a model.

## Run it

```bash
git clone https://github.com/kru3ish/tally && cd tally
npm install
npm test              # typecheck, esbuild bundle to dist/, vitest (about 200 tests, ~2 min)
npm run build         # dist/cli.js and dist/hook.js only
node dist/cli.js demo # the fixture session end to end, stubbed model, throwaway data dir
```

`dist/` is committed because the plugin marketplace clones the repository. CI fails if a fresh build differs from what is committed, so run `npm run build` before you commit.

Tests isolate `TALLY_HOME` and `CLAUDE_CONFIG_DIR` in temp directories (`test/helpers.ts`); nothing touches your real `~/.tally` or `~/.claude`. The hook timing test asserts the hook finishes under 150 ms; keep anything on the hook path free of I/O beyond one file append.

## Where things are

`ARCHITECTURE.md` has the map. Short version: `src/agents/` (per-agent edges), `src/core/` (normalised events, Task Contract), `src/assurance/` (Evidence Map), `src/judge/` (tiers, checks, verification, receipts), `src/coach/` (rules and autopilot), `src/commands/` (one file per CLI command), `test/` (one file per concern, `h*` for horizontal features, `m*` for milestones).

## Good ways in

Each of these can be done without understanding the whole system.

| Label | What it means | Start here |
|---|---|---|
| `good first adapter` / `adapter wanted` | Teach Tally another coding agent (OpenCode, Aider, Copilot, an internal harness) | `docs/ADAPTER_SDK.md`, `src/agents/index.ts`, `test/h15-agents.test.ts` |
| `assurance` | A new evidence kind, a better status rule, a false VERIFIED you caught | `src/assurance/index.ts`, `test/h16-assurance.test.ts` |
| `evaluation` | A fixture that encodes a failure mode, a grading of your own sessions | `docs/EVALUATION.md`, `test/fixtures/calibration/` |
| `observability` | A metric with a clear definition, a Coach rule with measured precision | `src/coach/rules/`, `src/cost/waste.ts`, `test/m5-coach-rules.test.ts` |
| `memory` | Repository memory and mistake memory (roadmap v0.7) | `docs/ROADMAP_RELIABILITY_LAYER.md` |
| `good first issue` | Small, scoped, with a test to make green | the issue itself |

### Adding a mechanical check

Checks are how a criterion is decided with no model. Add the kind to `CheckSpecSchema` and `CHECK_KINDS` in `src/judge/checks.ts`, resolve it in `resolveCheck`, mirror the fast version in `src/judge/quickcheck.ts` (the Stop gate and status line use it), and teach the intake prompt when to emit it (`src/task/intake.ts`). Test in `test/m4-judge.test.ts` and `test/h13-agent.test.ts`.

### Adding an evidence kind

Add it to `EvidenceKind` in `src/assurance/index.ts`, produce items in `buildAssurance`, and decide how it affects the status: deterministic items can verify; interpreted items cannot on their own. Add a case to `test/h16-assurance.test.ts` that shows the status with and without the new item. If it could ever produce a VERIFIED that a human would call unmet, that is a bug, not a feature.

### Adding a Coach rule

One file in `src/coach/rules/`, registered in `rules/index.ts`. Rules are deterministic and read the session's events; they return suggestions with a stable `key` for de-duplication and an `action` (`inject` for observations, `write` or `settings` for changes the user must approve). Replay it against the fixture in `test/m5-coach-rules.test.ts`, and add it to the precision table when you have graded it (`tally calibrate report`).

### Adding an evaluation case

A directory under `test/fixtures/calibration/` with `task.json`, `repo.json` and `expected.json` (see `docs/EVALUATION.md`). Record it once with `tally calibrate eval --live --record --only <name>`; CI replays it. Good fixtures fail interestingly.

## Conventions

- Comments say why, not what. If the code needs a paragraph to explain what it does, change the code.
- Every user-facing number has a definition and a source. If Tally cannot observe something, it says so; it does not estimate unless the output says ESTIMATED.
- New stored fields are optional. Old `judge.json`, `task.json` and `events.jsonl` files must keep loading.
- One logical change per commit, imperative subject line, and a `CHANGELOG.md` entry under `Unreleased` for anything a user would notice.
- Judgment calls go in `DECISIONS.md` with the reason, including what was cut and why.

## Reporting

Bugs and false verifications: open an issue with the session's `report.md` and `judge.json` (they contain criteria text and file paths, never prompts or code; check before posting). Security: see `SECURITY.md`.
