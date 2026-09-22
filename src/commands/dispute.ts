/* `tally dispute <session> <criterion> --status met|partial|unmet|unverifiable --reason "..." [--by name]`
   A developer contests a criterion; the receipt keeps the original status next to the override and is re-scored;
   the dispute is appended to ~/.tally/calibration.jsonl (source "dispute") so it feeds calibration as a labelled
   disagreement with a stated reason. */
import os from 'node:os';
import { type Args, flag } from '../cli.js';
import { loadJudge, rescoreJudge, persistJudge, renderSummary } from '../judge/judge.js';
import { loadTask } from '../task/intake.js';
import { appendLine, ensureDir, tallyHome, sessionDir } from '../paths.js';
import { resolveSession } from '../session.js';
import fs from 'node:fs';
import { calibrationFile, type CalibrationEntry } from '../calibrate/calibrate.js';
import { appendEvent } from '../store/events.js';
import type { Judge } from '../judge/schema.js';
import path from 'node:path';

const STATUSES = ['met', 'partial', 'unmet', 'unverifiable'] as const;
type Status = (typeof STATUSES)[number];

export function disputeCriterion(session: string, id: string, status: Status, reason: string, by: string): { judge: Judge; entry: CalibrationEntry } {
  const j = loadJudge(session);
  if (!j) throw new Error(`no receipt for session ${session}`);
  const c = j.criteria.find((x) => x.id === id);
  if (!c) throw new Error(`no criterion ${id} on this receipt (${j.criteria.map((x) => x.id).join(', ')})`);
  if (!reason.trim()) throw new Error('a reason is required');
  const original = c.override?.original ?? c.status;
  c.override = { status, reason: reason.trim(), by, ts: new Date().toISOString(), original };
  const next = rescoreJudge(j, `disputed ${id}: ${original} → ${status} by ${by}`);
  persistJudge(next, loadTask(session));
  appendLine(path.join(sessionDir(session), 'disputes.jsonl'), JSON.stringify({ ts: c.override.ts, id, original, status, reason: c.override.reason, by }));
  appendEvent({ ts: c.override.ts, type: 'dispute', session, cwd: j.cwd, data: { id, original, status, by } });
  const entry: CalibrationEntry = {
    ts: c.override.ts,
    session,
    source: 'dispute',
    grader: by,
    task_title: j.task.title,
    criteria: [{ id, text: c.text, judge: original, human: status, evidence: `${c.evidence} · dispute: ${c.override.reason}` }],
    judge_verdict: j.verdict.verdict,
    task_source: j.task.task_source,
  };
  ensureDir(tallyHome());
  appendLine(calibrationFile(), JSON.stringify(entry));
  return { judge: next, entry };
}

/* an 8-character prefix (what receipts and hints print) resolves to the full session id */
export function resolveSessionPrefix(p: string): string {
  if (fs.existsSync(sessionDir(p))) return p;
  const root = path.join(tallyHome(), 'sessions');
  const hits = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => d.startsWith(p)) : [];
  if (hits.length === 1) return hits[0]!;
  throw new Error(hits.length ? `"${p}" matches ${hits.length} sessions; give more characters` : `no session starting with "${p}"`);
}

/* the plugin's /tally:dispute passes one string: "<criterion> <status> <reason…>" */
export function parseDisputeArgs(text: string): { id: string; status: Status; reason: string } | null {
  const m = /^\s*(c\d+)\s+(met|partial|unmet|unverifiable)\s+(.+)$/i.exec(text);
  if (!m) return null;
  return { id: m[1]!.toLowerCase(), status: m[2]!.toLowerCase() as Status, reason: m[3]!.trim() };
}

export async function run(args: Args): Promise<number | void> {
  let session: string | undefined;
  let id: string | undefined;
  let status: Status | undefined;
  let reason: string | undefined;
  const fromArgs = flag(args, 'from-args');
  if (fromArgs !== undefined) {
    const parsed = parseDisputeArgs(fromArgs);
    if (!parsed) {
      process.stderr.write('Usage: /tally:dispute <c2> <met|partial|unmet|unverifiable> <reason>\n');
      return 1;
    }
    ({ id, status, reason } = parsed);
    session = resolveSession(flag(args, 'session'), process.cwd());
  } else {
    [session, id] = args._;
    status = flag(args, 'status') as Status | undefined;
    reason = flag(args, 'reason');
  }
  if (!session || !id || !status || !STATUSES.includes(status) || !reason) {
    process.stderr.write('Usage: tally dispute <session> <criterion> --status met|partial|unmet|unverifiable --reason "<why>" [--by name]\n');
    return 1;
  }
  const full = resolveSessionPrefix(session);
  const r = disputeCriterion(full, id, status, reason, flag(args, 'by') ?? os.userInfo().username);
  process.stdout.write(`Recorded: ${id} ${r.entry.criteria[0]!.judge} → ${status} (${reason}). The receipt is re-scored; the dispute is in the calibration log.\n\n`);
  process.stdout.write(renderSummary(r.judge, false) + '\n');
}
