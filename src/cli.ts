import { log, packageRoot, readJson } from './paths.js';
import path from 'node:path';

export function packageVersion(): string {
  return readJson<{ version?: string }>(path.join(packageRoot(), 'package.json'), {}).version ?? '0.0.0';
}

export interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          out.flags[key] = next;
          i += 1;
        } else {
          out.flags[key] = true;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

export function flag(args: Args, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === 'string' ? v : undefined;
}

export function has(args: Args, name: string): boolean {
  return args.flags[name] !== undefined && args.flags[name] !== false;
}

const COMMANDS: Record<string, () => Promise<{ run: (args: Args) => Promise<number | void> }>> = {
  install: () => import('./commands/install.js'),
  uninstall: () => import('./commands/install.js').then((m) => ({ run: m.runUninstall })),
  task: () => import('./commands/task.js'),
  judge: () => import('./commands/judge.js'),
  finalize: () => import('./commands/finalize.js'),
  followup: () => import('./commands/followup.js'),
  watch: () => import('./commands/watch.js'),
  start: () => import('./commands/start.js'),
  coach: () => import('./commands/coach.js'),
  undo: () => import('./commands/undo.js'),
  experiment: () => import('./commands/experiment.js'),
  report: () => import('./commands/report.js'),
  doctor: () => import('./commands/doctor.js'),
  demo: () => import('./commands/demo.js'),
  status: () => import('./commands/status.js'),
  statusline: () => import('./commands/statusline.js'),
  config: () => import('./commands/config.js'),
  sessions: () => import('./commands/sessions.js'),
  otel: () => import('./commands/otel.js'),
  calibrate: () => import('./commands/calibrate.js'),
  backfill: () => import('./commands/backfill.js'),
  dispute: () => import('./commands/dispute.js'),
  budget: () => import('./commands/budget.js'),
  playbook: () => import('./commands/playbook.js'),
  export: () => import('./commands/export.js'),
  mcp: () => import('./commands/mcp.js'),
  onboard: () => import('./commands/onboard.js'),
  ask: () => import('./commands/ask.js'),
  replay: () => import('./commands/replay.js'),
  prompts: () => import('./commands/prompts.js'),
};

const HELP = `tally — per-task receipts and live coaching for Claude Code

Usage: tally <command> [options]

Setup
  install [--project]         Add Tally hooks + status line to Claude Code settings (backs up first)
  uninstall [--project]       Remove hooks; settings return byte-identical
  doctor                      Check claude, gh, hooks, pricing, config
  config [key value]          Show or set config (hourly_rate, writeback, auto_apply, models.*)

Judge
  task <url|path|text>        Link a task to the current session; freeze acceptance criteria
  judge [session] [--post]    Produce the receipt (judge.json + report.md); --post comments on issue/PR
  judge <session> --explain <c1|all>   The evidence behind a status: diff hunks, test output, transcript moments
  dispute <session> <c#> --status s --reason ".."   Contest a criterion; the receipt keeps both and is re-scored
  budget status|approve       Repo-policy hard stop over budget (tally.json), and the approval that lifts it
  playbook [--all] [--write]  Recurring lessons across receipts, as a CLAUDE.md snippet
  mcp [--install]             MCP server: Claude asks tally_task / tally_unmet / tally_receipt / tally_flags mid-task
  export [--since 30d] [--out f.jsonl] [--titles]   Numbers-only receipts for a team store
  followup [session]          Post-merge truth: merged, reverted, reopened, review churn, CI
  report                      Trends: cost per task, completion, rework, skill/MCP payoff, estimate vs outcome
  onboard [--since 30d]       One-page report from the transcripts already on disk (no model calls)
  ask "<question>"            Ask a question over the receipts (numbers only); cites the sessions
  replay <session>            Timeline with the off-track moments marked
  prompts [--all]             What your best tasks' opening prompts had in common, and a template
  export --invoice [--out f.md|f.csv]   Invoice-ready lines: task, criteria met, test result, cost
  sessions                    List tracked sessions
  status [--session id]       What Tally knows about a session

Coach
  start                       Open the Coach pane (tmux split if available)
  watch [session]             Attach the Coach to the latest active session
  coach --once                Print pending suggestions and exit
  coach --tick                One autopilot pass (the Stop hook runs this after every turn)
  statusline [--install]      Claude Code status line: task, spend vs budget, context, Coach flags
  undo [n]                    Reverse the last Coach change(s)

Experiments
  experiment start <skill|mcp> <name> --tasks N
  experiment report
  experiment stop

Backfill (past sessions from ~/.claude/projects)
  backfill list [--since 60d] [--repo path]     candidates with cost and detected task link
  backfill add <session|all> [--task <url|text>] [--max-spend 3]   reconstruct, judge, follow up, replay the Coach

Calibration
  calibrate grade <session> [--grader name]     blind grading of a backfilled receipt
  calibrate add <session> --human met,partial,... [--verdict "worth it"]
  calibrate report [--source backfill|human|fixture]   agreement, confusion, lean, inter-grader, Coach precision
  calibrate rescore [--grader name]             refresh the judge side of graded sessions from their current receipts
  calibrate eval [--live] [--record] [--fail-below N]   Regression eval on the fixture sessions

Other
  otel [--port 4318]          Loopback OTLP receiver for Claude Code telemetry (optional cost cross-check)
  demo                        Replay a fixture session end to end with a stubbed LLM
`;

/* Printed after a command that ran from the plugin's slash commands (`--plugin`): what the npm CLI adds. */
const PLUGIN_HINTS: Record<string, string> = {
  coach: 'The live Coach pane with one-key actions needs the CLI: npm i -g @kru3ish/tally, then `tally watch` in a second terminal.',
  status: 'For the live Coach pane, backfill and blind grading install the CLI: npm i -g @kru3ish/tally',
  report: 'Receipts for past sessions and blind grading need the CLI: npm i -g @kru3ish/tally, then `tally backfill list` and `tally calibrate grade`.',
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._.shift();
  if (has(args, 'version') || cmd === 'version') {
    /* the version comes from package.json so the CLI, the plugin manifest and the marketplace can never disagree */
    process.stdout.write(`tally ${packageVersion()}\n`);
    return;
  }
  if (!cmd || cmd === 'help' || cmd === '--help' || has(args, 'help')) {
    process.stdout.write(HELP);
    return;
  }
  const loader = COMMANDS[cmd];
  if (!loader) {
    process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  try {
    const mod = await loader();
    const code = await mod.run(args);
    if (typeof code === 'number') process.exitCode = code;
    if (has(args, 'plugin') && PLUGIN_HINTS[cmd]) process.stdout.write(`\n${PLUGIN_HINTS[cmd]}\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    log(`command ${cmd} failed: ${msg}`);
    if (has(args, 'auto')) return;
    process.stderr.write(`tally ${cmd}: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

void main();
