# Launch post (~400 words)

Placeholders in `{{…}}` are filled by `npx tsx scripts/fill-calibration.ts` after blind-grading real sessions.

---

## Tally: a receipt for every Claude Code task

Claude Code tells you what you spent. It does not tell you what you got.

`/cost` and ccusage give totals by session and model. `/insights` tells you which habits recur. Neither ties a dollar to a ticket. So after a $6 session I could not answer the only question that matters: did the task get done, at what cost, and would I do it again?

Tally is a small local tool that answers that per task. It runs as a Claude Code plugin (or as hooks installed by an npm CLI) and does three things.

**It freezes the task.** Paste a GitHub, Jira or Linear link in your first prompt and Tally pulls the ticket and writes down the acceptance criteria before any code exists. No ticket? It infers the task from your prompts, branch and commits, labels it unconfirmed, and asks you to confirm, edit or link with one key. The goalposts cannot move after that.

**It judges the result.** When you push, Tally collects the diff, every test command the session ran, and the final message; then it re-runs your tests itself, because "all tests pass" in a transcript is a claim, not evidence. Each criterion gets met / partial / unmet / unverifiable with a cited line. Completion, cost by phase, waste in dollars, ROI and a verdict are computed, not asked for. Seven days later it checks whether the PR was merged, reverted or reopened, and adjusts the verdict.

**It coaches while you work.** A terminal pane beside Claude Code with thirteen deterministic rules: the same command failing three times, the same file read three times, context at 85%, an MCP server loaded but unused for ten sessions, spend at 80% of the budget. Each suggestion has one-key actions, and what reaches Claude is an observation, not an instruction.

The Judge is tiered so it stays cheap: mechanical checks first, a small model on the rest, a stronger model only where a criterion could flip the verdict. On the calibration fixtures Tally's own spend is 4.1% of the session's.

How accurate is it? Honestly: early. On five authored sessions with known answers, 19/19 criteria and 5/5 verdicts. On {{CALIBRATION_SESSIONS}} of my own real sessions, blind-graded before seeing Tally's answer, criterion agreement is {{CALIBRATION_CRITERION_AGREEMENT}} and verdict agreement {{CALIBRATION_VERDICT_AGREEMENT}}. That is a second opinion, not an oracle, and the README says so.

Everything is local. Hooks make no network calls and finish in under 150 ms; model calls go through your existing `claude` login; nothing is uploaded.

```
/plugin marketplace add kru3ish/tally
/plugin install tally@tally
npm i -g @kru3ish/tally && tally doctor
```

Code, calibration numbers and the decision log: https://github.com/kru3ish/tally. Grade a few of your own sessions with `tally calibrate grade` and send me the report; that is the data this needs next.
