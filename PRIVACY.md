# Privacy

What Tally stores, what leaves the machine, and the exact schema of the optional anonymous metrics. SECURITY.md covers the threat model and how to report a problem.

## What stays on the machine

Everything the hooks record: events, receipts, the Task Contract, feedback labels, the usefulness answer. All of it lives under `~/.tally` (or `TALLY_HOME`), redacted before it is written, and `rm -rf ~/.tally` removes it. `tally uninstall` restores your agent settings byte for byte.

## What can leave the machine, and when

- **Model calls**, when the Judge, Coach or intake run: through `claude -p` on your own Claude login by default, or to the `models.base_url` you configure (a local server for air-gapped use). Sent: the frozen criteria, a trimmed diff and test output, tool names and truncated command lines, the assistant's final message. Prompts go to intake only when a task is inferred from them. This is the one place code leaves the machine; point `models.provider` at a local endpoint if it must not.
- **Tracker calls** (`gh`, Jira, Linear, GitHub's REST API) only for the ticket you linked; write-back only with `--post` or `writeback: true`, carrying statuses, cost and criteria text.
- **Anonymous metrics**, only if you opted in. Schema below.
- **A wrong-verdict report** (`tally feedback wrong <c#> --report`) goes nowhere by itself: it is shown, saved to a file you can read, and opening a GitHub issue with it is a separate default-No question.

## Anonymous metrics (opt-in, default off)

The first interactive run asks once: `Enable anonymous metrics? [y/N]`. No answer, `n`, `TALLY_TELEMETRY=0`, or a CI environment all mean off. `tally telemetry status` shows the state, `tally telemetry show` prints exactly what would be sent, `tally telemetry on|off` switches it. `off` deletes the installation id and anything queued.

Sending never blocks or slows a command: events are queued locally and a detached process posts them with a four-second timeout; failures are silent and the queue is capped at 500 events.

### Schema `tally.telemetry.v1`

Every event is a JSON object with only these fields. The list is the allowlist in `src/telemetry/index.ts`; a field not on it cannot be sent.

| Field | Type | Meaning |
|---|---|---|
| `schema` | `"tally.telemetry.v1"` | |
| `ts` | ISO timestamp | when the event was recorded |
| `installation_id` | UUID | random, created locally on opt-in, not derived from the machine; deleted by `tally telemetry off` |
| `tally_version` | string | e.g. `0.6.1` |
| `agent` | `claude-code` \| `codex` \| `gemini` \| `cursor` \| `unknown` | the agent product; never a model name or version |
| `command` | string | the Tally command name, e.g. `verify` |
| `success` | boolean | whether the command exited 0 |
| `criteria` | `{verified, supported, unverified, unmet}` | counts on the receipt, for `verify` and `judge` |
| `verdict` | string | the verdict word: `worth it`, `borderline`, `not worth it`, `insufficient evidence` |
| `feedback_label` | `correct` \| `wrong` \| `unsure` | from `tally feedback` |
| `false_verified` | boolean | a `wrong` label on a VERIFIED criterion |
| `usefulness_answer` | `yes` \| `no` \| `skip` | the one-time question |

Example:

```json
{
  "schema": "tally.telemetry.v1",
  "ts": "2026-09-28T10:15:00.000Z",
  "installation_id": "5f0d2c1e-…",
  "tally_version": "0.6.1",
  "agent": "claude-code",
  "command": "verify",
  "success": true,
  "criteria": { "verified": 2, "supported": 1, "unverified": 1, "unmet": 0 },
  "verdict": "borderline"
}
```

### Never sent

Prompts, code, diffs, file names or paths, repository names or URLs, task or criterion text, evidence text, terminal output, hostnames, usernames, email addresses, model names, IP-derived identity.

### The receiving side

Metrics go to the endpoint in `TALLY_TELEMETRY_ENDPOINT` (or `endpoint` in `~/.tally/telemetry.json`). Until an endpoint is configured nothing is sent even when metrics are on, and `tally telemetry status` says so. The endpoint Tally's maintainer runs must not store IP addresses or request headers beyond what is needed to accept the POST; that requirement is part of this document and any endpoint that does not meet it is not a Tally endpoint.
