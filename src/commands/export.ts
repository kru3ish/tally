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

/* Invoice-ready lines for freelancers and agencies: proof of delivered, verified work rather than hours. */
export function invoiceRows(entries: HistoryEntry[]): Array<Record<string, string | number>> {
  return entries.map((h) => {
    const j = h.session ? loadJudge(h.session) : null;
    const met = j ? j.criteria.filter((c) => (c.override?.status ?? c.status) === 'met').length : '';
    return {
      date: (h.ts ?? '').slice(0, 10),
      task: h.task_title ?? '',
      criteria_met: j ? `${met}/${j.criteria.length}` : '',
      independent_test: j ? (j.verification.ran ? (j.verification.passed ? 'passed' : 'failed') : 'not run') : '',
      estimate_hours: j?.value.estimate_hours ?? '',
      ai_cost_usd: h.cost_usd ?? '',
      verdict: h.final_verdict ?? h.verdict ?? '',
      session: (h.session ?? '').slice(0, 8),
    };
  });
}

export function renderInvoice(rows: Array<Record<string, string | number>>, format: 'md' | 'csv'): string {
  const cols = ['date', 'task', 'criteria_met', 'independent_test', 'estimate_hours', 'ai_cost_usd', 'verdict', 'session'];
  if (format === 'csv') return [cols.join(','), ...rows.map((r) => cols.map((c) => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n') + '\n';
  const total = rows.reduce((s, r) => s + (Number(r.ai_cost_usd) || 0), 0);
  return [`| ${cols.join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${cols.map((c) => String(r[c] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`), '', `Total AI cost (API-equivalent): $${total.toFixed(2)} across ${rows.length} task(s). Generated locally by Tally; each line links to a receipt with the evidence.`].join('\n') + '\n';
}

export async function run(args: Args): Promise<number | void> {
  const since = flag(args, 'since');
  const cutoff = since ? parseSince(since) : 0;
  const repo = flag(args, 'repo');
  const rows = loadHistory()
    .filter((e) => e.verdict && !e.internal && (!repo || e.repo === repo) && (!cutoff || Date.parse(e.ts ?? '') >= cutoff))
    .map((e) => exportRow(e, has(args, 'titles')));
  const out = flag(args, 'out');
  if (has(args, 'invoice')) {
    const entries = loadHistory().filter((e) => e.verdict && !e.internal && (!repo || e.repo === repo) && (!cutoff || Date.parse(e.ts ?? '') >= cutoff));
    const inv = renderInvoice(invoiceRows(entries), out?.endsWith('.csv') ? 'csv' : 'md');
    if (out) {
      fs.writeFileSync(out, inv);
      process.stdout.write(`${entries.length} invoice line(s) → ${out}\n`);
    } else process.stdout.write(inv);
    return;
  }
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  if (out) {
    fs.writeFileSync(out, text);
    process.stdout.write(`${rows.length} receipt(s) → ${out} (numbers, statuses and outcomes only${has(args, 'titles') ? ', with task titles' : ''}).\n`);
  } else process.stdout.write(text);
}
