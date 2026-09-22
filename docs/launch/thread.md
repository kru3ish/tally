# X / LinkedIn thread (5 posts)

Fill `{{…}}` with `npx tsx scripts/fill-calibration.ts`. Attach `docs/demo.svg` (or a GIF export of `docs/demo.cast`) to post 1.

---

**1/**
Claude Code tells you what you spent. It doesn't tell you what you got.

I built Tally: a receipt per task. Acceptance criteria frozen at intake → what shipped → what it cost → whether it held up after merge → worth it or not.

Local, open source, preview: github.com/kru3ish/tally

**2/**
How a receipt is made:
- pull the ticket, freeze the criteria before any code exists
- on push: diff + every test command the session ran + the final message
- re-run the tests myself (a transcript saying "tests pass" is a claim)
- met / partial / unmet / unverifiable per criterion, with the evidence line

**3/**
It's tiered so it stays cheap. Mechanical checks first (free), a small model on the rest, a stronger one only where a criterion could flip the verdict.

Tally's own spend on the calibration receipts: 4.1% of the session. Every receipt prints its own share.

**4/**
The Coach runs on its own, no pane to open. Same command failing 3×, same file read 3×, context at 85%, an MCP server loaded but unused for 10 sessions, spend at 80% of budget. What reaches Claude is an observation, never an instruction. The status line shows task, spend vs budget and open flags.

**5/**
Accuracy, honestly: early.
Fixtures (5 sessions, 19 criteria): 19/19 criteria, 5/5 verdicts.
My own real sessions, blind-graded (n={{CALIBRATION_SESSIONS}}): {{CALIBRATION_CRITERION_AGREEMENT}} criterion agreement, {{CALIBRATION_VERDICT_AGREEMENT}} verdicts.

/plugin marketplace add kru3ish/tally → /plugin install tally@tally
Grade your own sessions with `tally calibrate grade` and tell me where it's wrong.
