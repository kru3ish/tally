/* The Claude Code status line: `tally statusline` reads the JSON Claude Code passes on stdin and prints one line with
   the linked task, spend against budget, context use and open Coach flags. It touches no transcript, so it runs in a
   few milliseconds on every 300 ms refresh. `--install` points settings.json at it. */
import fs from 'node:fs';
import path from 'node:path';
import { type Args, has } from '../cli.js';
import { loadTask } from '../task/intake.js';
import { loadJudge } from '../judge/judge.js';
import { sessionDir, builtCliPath } from '../paths.js';
import { installStatusLine, uninstallStatusLine, settingsPath, enabledPluginIds } from '../install/install.js';
import { fmtUsd } from '../cost/pricing.js';

interface StatusInput {
  session_id?: string;
  cwd?: string;
  model?: { display_name?: string };
  cost?: { total_cost_usd?: number };
  context_window?: { used_percentage?: number | null };
}

export interface CoachFlags {
  pending: Array<{ rule: string; key: string; title: string; usd_saved: number; ts?: string; label?: string }>;
  updated?: string;
}

export function flagsFile(session: string): string {
  return path.join(sessionDir(session), 'coach-flags.json');
}

export function readFlags(session: string): CoachFlags {
  const f = flagsFile(session);
  if (!fs.existsSync(f)) return { pending: [] };
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')) as CoachFlags;
  } catch {
    return { pending: [] };
  }
}

const C = { reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', green: '\x1b[32m' };

export function renderStatusLine(input: StatusInput, color = true): string {
  const paint = (code: string, s: string) => (color ? `${code}${s}${C.reset}` : s);
  const session = input.session_id;
  const task = session ? loadTask(session) : null;
  const judge = session ? loadJudge(session) : null;
  const flags = session ? readFlags(session).pending.length : 0;
  const spend = input.cost?.total_cost_usd ?? 0;
  const parts: string[] = [paint(C.dim, 'Tally')];
  if (task) {
    const title = task.title.length > 34 ? task.title.slice(0, 33) + '…' : task.title;
    parts.push(`${title}${task.inferred && !task.confirmed ? paint(C.dim, ' (unconfirmed)') : ''}`);
    const pct = task.budget_usd ? Math.round((spend / task.budget_usd) * 100) : null;
    const budgetStr = pct === null ? fmtUsd(spend) : `${fmtUsd(spend)}/${fmtUsd(task.budget_usd)} (${pct}%)`;
    parts.push(pct !== null && pct >= 100 ? paint(C.red, budgetStr) : pct !== null && pct >= 80 ? paint(C.yellow, budgetStr) : budgetStr);
  } else {
    parts.push(paint(C.dim, `no task linked · ${fmtUsd(spend)}`));
  }
  const ctx = input.context_window?.used_percentage;
  if (typeof ctx === 'number') parts.push(ctx >= 85 ? paint(C.red, `ctx ${Math.round(ctx)}%`) : ctx >= 70 ? paint(C.yellow, `ctx ${Math.round(ctx)}%`) : `ctx ${Math.round(ctx)}%`);
  /* the slash command only exists with the plugin; CLI installs get the CLI command */
  if (flags) parts.push(paint(C.cyan, `${flags} coach flag${flags === 1 ? '' : 's'} (${enabledPluginIds().length ? '/tally:coach' : 'tally coach'})`));
  if (judge) parts.push(paint(judge.verdict.verdict === 'worth it' ? C.green : judge.verdict.verdict === 'not worth it' ? C.red : C.yellow, `receipt: ${judge.completion_pct}% · ${judge.verdict.verdict}`));
  return parts.join(paint(C.dim, ' · '));
}

export async function run(args: Args): Promise<number | void> {
  if (has(args, 'install')) {
    const r = installStatusLine({ force: has(args, 'force') });
    process.stdout.write(r.installed ? `Status line installed in ${r.file}: ${r.command}\nRestart Claude Code (or start a new session) to see it.\n` : `${r.reason}\n`);
    return r.installed ? 0 : 1;
  }
  if (has(args, 'uninstall')) {
    const r = uninstallStatusLine();
    process.stdout.write(r.removed ? `Status line removed from ${settingsPath('user')}\n` : 'No Tally status line configured.\n');
    return;
  }
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }
  if (!raw.trim()) {
    process.stdout.write(`tally statusline reads Claude Code's status-line JSON on stdin. Install it with: tally statusline --install\n(settings.json → "statusLine": { "type": "command", "command": "node \\"${builtCliPath().replace(/\\/g, '/')}\\" statusline" })\n`);
    return;
  }
  let input: StatusInput = {};
  try {
    input = JSON.parse(raw) as StatusInput;
  } catch {
    input = {};
  }
  process.stdout.write(renderStatusLine(input, !has(args, 'plain')) + '\n');
}
