/* `tally export [--since 30d] [--repo key] [--out file.jsonl] [--titles]`: one JSON line per receipt with numbers,
   statuses and outcomes only. No prompts, no code, no criterion text, and no task titles unless --titles. This is the
   record a team can collect centrally without collecting anyone's work. */
import fs from 'node:fs';
import { type Args, flag, has } from '../cli.js';
import { loadHistory } from '../coach/context.js';
import { loadJudge } from '../judge/judge.js';
import { parseSince } from '../backfill/scan.js';
import type { HistoryEntry } from '../coach/types.js';

export interface ExportRow {
  schema: 'tally.receipt.v1';
  session: string;
  ts?: string;
  repo?: string;
  task_source?: string;
  task_title?: string;
  cost_usd?: number;
  tally_own_usd?: number;
  waste_usd?: number;
  completion_pct?: number;
  completion_basis?: { verifiable: number; total: number };
  counts?: { met: number; partial: number; unmet: number; unverifiable: number };
  criteria?: Array<{ id: string; status: string; resolved_by: string; overridden?: boolean }>;
  quality?: number;
  roi?: number | null;
  verdict?: string;
  final_status?: string;
  final_verdict?: string;
  review_rounds?: number;
  hours_to_approval?: number;
  spec_quality?: number;
  models?: string[];
  tiers?: string[];
  disputes?: number;
}

export function exportRow(h: HistoryEntry, titles: boolean): ExportRow {
  const j = h.session ? loadJudge(h.session) : null;
  const row: ExportRow = {
    schema: 'tally.receipt.v1',
    session: h.session ?? '',
    ts: h.ts,
    repo: h.repo,
    task_source: h.task_source,
    cost_usd: h.cost_usd,
    tally_own_usd: h.tally_own_usd,
    waste_usd: h.waste_usd,
    completion_pct: h.completion_pct,
    quality: j?.quality.score,
    roi: h.roi ?? null,
    verdict: h.verdict,
    final_status: h.final_status,
    final_verdict: h.final_verdict,
    spec_quality: h.spec_quality,
  };
  if (titles) row.task_title = h.task_title;
  if (j) {
    row.completion_basis = j.completion_basis;
    row.counts = j.counts;
    row.criteria = j.criteria.map((c) => ({ id: c.id, status: c.override?.status ?? c.status, resolved_by: c.resolved_by, ...(c.override ? { overridden: true } : {}) }));
    row.tiers = j.tiers.ran;
    row.models = Object.keys(j.cost.by_model ?? {});
    row.review_rounds = j.followup?.review_rounds;
    row.hours_to_approval = j.followup?.hours_to_approval;
    row.disputes = j.criteria.filter((c) => c.override).length;
  }
  return row;
}

export async function run(args: Args): Promise<number | void> {
  const since = flag(args, 'since');
  const cutoff = since ? parseSince(since) : 0;
  const repo = flag(args, 'repo');
  const rows = loadHistory()
    .filter((e) => e.verdict && !e.internal && (!repo || e.repo === repo) && (!cutoff || Date.parse(e.ts ?? '') >= cutoff))
    .map((e) => exportRow(e, has(args, 'titles')));
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  const out = flag(args, 'out');
  if (out) {
    fs.writeFileSync(out, text);
    process.stdout.write(`${rows.length} receipt(s) → ${out} (numbers, statuses and outcomes only${has(args, 'titles') ? ', with task titles' : ''}).\n`);
  } else process.stdout.write(text);
}
