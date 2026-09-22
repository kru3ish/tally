# Show HN

Fill `{{…}}` with `npx tsx scripts/fill-calibration.ts`.

**Title:** Show HN: Tally – a receipt per task for Claude Code (criteria in, cost and verdict out)

**URL:** https://github.com/kru3ish/tally

**First comment:**

Hi HN. Tally is a local tool for Claude Code that writes a receipt for each task instead of a bill for each session.

The gap it fills: `/cost`, `/usage` and ccusage tell you what you spent; `/insights` tells you what habits recur. Nothing ties spend to a ticket. Tally freezes the ticket's acceptance criteria at the start of the session (from GitHub/Jira/Linear, a .md file, or, with no ticket, inferred from your prompts and commits and marked unconfirmed until you confirm it). When you push, it collects the diff and every test command the session ran, re-runs the tests itself in a scrubbed environment, and rates each criterion met/partial/unmet/unverifiable with a cited line. Completion %, cost by phase, waste in dollars, ROI and the verdict are computed rather than asked of the model. A week later it checks whether the PR was merged, reverted or reopened and adjusts the verdict.

Design choices I expect pushback on:

- Verdicts are deterministic thresholds over model-rated criteria, not a model's opinion of "worth it". A model rates the criteria; arithmetic decides.
- The judge is tiered: mechanical checks (file exists, diff contains, tests pass) resolve for free; a small model handles the rest with a trimmed evidence pack; a stronger model only re-checks criteria where a one-step change would flip the verdict, or where the small model called a correctness criterion partial/unmet. Self-overhead on the fixtures is 4.1% of session spend.
- "Tests pass" in a transcript is treated as a claim. If Tally cannot run the tests itself (no consent, no test command, no real tree), the criterion is `unverifiable`, never `met`.
- The Coach runs on its own (a Stop hook spawns one pass per turn, observations land on the next prompt, human decisions become status-line flags), so nothing has to be opened.
- Injected coaching notes are phrased as observations ("Tally observed npm test fail 3 times"), not instructions, because hook context is context, not a command channel.

Accuracy is early and the README says so: 19/19 criteria and 5/5 verdicts on five authored fixture sessions; on {{CALIBRATION_SESSIONS}} of my own real sessions blind-graded before seeing Tally's answer, {{CALIBRATION_CRITERION_AGREEMENT}} criterion agreement and {{CALIBRATION_VERDICT_AGREEMENT}} verdict agreement. The grading tool is in the package (`tally calibrate grade`), and the thing I most want from this thread is people's disagreement tables.

Everything runs locally; hooks make no network calls and finish in under 150 ms; model calls go through your existing `claude` login. MIT, TypeScript, no runtime dependencies. Install as a plugin (`/plugin marketplace add kru3ish/tally`) or npm (`npm i -g @kru3ish/tally`).
