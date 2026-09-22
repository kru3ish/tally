/* `tally budget status|approve [--session id] [--note "..."]`: the hard stop a repo policy can impose when a session passes
   its budget, and the human approval that lifts it. The Coach tick writes the stop marker; the PreToolUse hook denies
   tool calls while it exists; approve records who lifted it and why. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { type Args, flag } from '../cli.js';
import { resolveSession } from '../session.js';
import { sessionDir, writeJson, readJson } from '../paths.js';
import { appendEvent } from '../store/events.js';
import { fmtUsd } from '../cost/pricing.js';

export interface HardStop {
  ts: string;
  spend_usd: number;
  budget_usd: number;
  policy_file?: string;
}

export function hardStopFile(session: string): string {
  return path.join(sessionDir(session), 'hard-stop.json');
}
export function approvalFile(session: string): string {
  return path.join(sessionDir(session), 'budget-approved.json');
}
export function readHardStop(session: string): HardStop | null {
  return readJson<HardStop | null>(hardStopFile(session), null);
}
export function isApproved(session: string): boolean {
  return fs.existsSync(approvalFile(session));
}

export function approveBudget(session: string, by: string, note?: string, cwd?: string): { lifted: boolean } {
  const lifted = fs.existsSync(hardStopFile(session));
  writeJson(approvalFile(session), { ts: new Date().toISOString(), by, note: note ?? '' });
  if (lifted) fs.unlinkSync(hardStopFile(session));
  appendEvent({ ts: new Date().toISOString(), type: 'budget_approved', session, cwd, data: { by, note: note ?? '', lifted } });
  return { lifted };
}

export async function run(args: Args): Promise<number | void> {
  const sub = args._[0] ?? 'status';
  const session = resolveSession(flag(args, 'session'), process.cwd());
  if (!session) {
    process.stderr.write('No session found.\n');
    return 1;
  }
  if (sub === 'approve') {
    const r = approveBudget(session, flag(args, 'by') ?? os.userInfo().username, flag(args, 'note'), process.cwd());
    process.stdout.write(r.lifted ? `Hard stop lifted for session ${session.slice(0, 8)}; tool calls are allowed again and the approval is recorded on the receipt.\n` : `Approval recorded for session ${session.slice(0, 8)} (no hard stop was active).\n`);
    return;
  }
  const stop = readHardStop(session);
  if (stop) process.stdout.write(`HARD STOP · session ${session.slice(0, 8)} spent ${fmtUsd(stop.spend_usd)} against a ${fmtUsd(stop.budget_usd)} budget${stop.policy_file ? ` (${stop.policy_file})` : ''}. Tool calls are denied until: tally budget approve --note "<why>"\n`);
  else process.stdout.write(`No hard stop active for session ${session.slice(0, 8)}${isApproved(session) ? ' (budget overrun approved)' : ''}.\n`);
}
