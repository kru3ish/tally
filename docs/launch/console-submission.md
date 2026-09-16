# Claude plugin directory submission (https://platform.claude.com/plugins/submit)

Paste the fields below. Fill `{{…}}` with `npx tsx scripts/fill-calibration.ts` first. The form's field names may differ; map by meaning.

**Plugin name:** Tally

**Marketplace / source:** `kru3ish/tally` (GitHub, `.claude-plugin/marketplace.json` at the repo root; plugin source `./`)

**Install command:** `/plugin marketplace add kru3ish/tally` then `/plugin install tally@tally`

**Version:** 0.1.0 (preview)

**Category:** Productivity / Developer tools

**One-line description (≤120 chars):**
Per-task receipts and live coaching for Claude Code: criteria in, what shipped, what it cost, whether it held up.

**Short description (≤500 chars):**
Tally freezes a ticket's acceptance criteria when a session starts, then on push collects the diff and test runs, re-runs the tests itself, rates each criterion with cited evidence, and computes completion, cost by phase, waste, ROI and a verdict. A week later it checks whether the PR was merged or reverted. A Coach pane flags loops, re-reads, context pressure, unused MCP servers and budget burn with one-key actions. Local only; hooks make no network calls; model calls use your own Claude login.

**Long description:**

Claude Code reports what a session cost. Tally reports what a task returned.

- **Intake:** GitHub, Jira, Linear, a `.md` file, or plain text. Criteria are frozen in `task.json`; spec quality is scored and the missing information listed. With no ticket the task is inferred from the prompts, branch and commits, marked unconfirmed until the user confirms, edits or links it.
- **Judge:** git diff, every test/lint command the session ran, ship events, the final message; independent test re-run with per-repo consent and a scrubbed environment; per-criterion met / partial / unmet / unverifiable with cited evidence; deterministic completion %, cost by phase and by model, waste in dollars, value, ROI and verdict. Tiered so it stays cheap: mechanical checks, then a small model, then a stronger model only where the verdict depends on it (self-overhead 4.1% of session spend on the calibration receipts).
- **Follow-up:** merged, reverted, reopened, review churn, CI after merge; verdict adjusted.
- **Coach:** thirteen deterministic rules plus an optional small-model pass; notes reach Claude as observations under a `Tally:` prefix, never as instructions.
- **Slash commands:** `/tally:task`, `/tally:judge`, `/tally:coach`, `/tally:report`, `/tally:tally`.

**What the plugin needs:** Node 18+ (hooks run `node ${CLAUDE_PLUGIN_ROOT}/dist/hook.js`), `git`. Optional: `gh` for GitHub intake, write-back and follow-up; the `@kru3ish/tally` npm CLI for the Coach pane, reports and backfill.

**Hooks used:** SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Stop, PreCompact, Notification (permission_prompt), SessionEnd. Exec form (`node` + args), no shell. Every hook exits 0, makes no network calls, and finishes in under 150 ms; SessionEnd spawns a detached process and returns immediately.

**Data and privacy:** Everything is stored under `~/.tally` (kept outside `${CLAUDE_PLUGIN_DATA}` so receipts survive plugin updates and are shared with the CLI). Hook events are redacted (keys, tokens, bearer headers, passwords in URLs) and truncated before writing. Outbound traffic is limited to `claude -p` on the user's login and, only when the user opts in, GitHub/Jira/Linear API calls. Write-back to issues/PRs is off by default and never includes prompts or code. Details in `SECURITY.md`.

**Accuracy statement:** Preview. Fixture regression: 19/19 criteria and 5/5 verdicts on 5 authored sessions. Real sessions, blind-graded: {{CALIBRATION_CRITERION_AGREEMENT}} criterion agreement, {{CALIBRATION_VERDICT_AGREEMENT}} verdict agreement on {{CALIBRATION_SESSIONS}} sessions ({{CALIBRATION_DATE}}). CI replays recorded model output and fails on regression.

**Testing:** `claude plugin validate . --strict` in CI; 141 tests on ubuntu, macOS and Windows × Node 18/22; clean install of the npm tarball in a fresh HOME on all three; install/uninstall of settings hooks verified byte-identical. `tally demo` replays a recorded session end to end with a stubbed model.

**License:** MIT

**Homepage / repository:** https://github.com/kru3ish/tally

**Support / security contact:** GitHub issues; private advisories at https://github.com/kru3ish/tally/security/advisories/new

**Author:** Krish Mehta (GitHub `kru3ish`)
