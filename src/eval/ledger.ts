/* The evaluation ledger: one JSON file per run under eval/results/<class>/, plus eval/results/ledger.jsonl with one
   line per run for aggregation. Public-safe by construction: statuses, evidence summaries, costs, commits, timings.
   No prompts, no code, no transcripts. Every field a later reader needs to reproduce or dispute the run is here. */
import fs from 'node:fs';
import path from 'node:path';
import type { AssuranceStatus } from '../assurance/index.js';

export type GradeStatus = 'met' | 'partial' | 'unmet' | 'unverifiable';

export interface CriterionResult {
  id: string;
  text: string;
  tally: { status: GradeStatus; assurance: AssuranceStatus; resolved_by: string; evidence: string[] };
  grader: { status: GradeStatus; evidence: string };
  agree: boolean;
  /* the two errors the project treats as bugs */
  false_verified: boolean;
  false_unmet: boolean;
}

export interface EvalRunResult {
  schema: 'tally.eval.v1';
  run_id: string;
  date: string;
  tally: { version: string; commit?: string };
  task: { id: string; class: 'fixture' | 'real' | 'historical'; repo: string; base: string; head: string; issue?: string; tags: string[]; contamination: string; human_fix?: string };
  agent: { product: string; model?: string; turns?: number; duration_s?: number; cost_usd?: number | null };
  grader: { product: string; model?: string; cost_usd?: number | null; blind: true };
  session: string;
  tally_summary: { verified: number; supported: number; unverified: number; unmet: number; total: number; verdict: string; completion_pct: number };
  grader_verdict?: string;
  tests: { independent_ran: boolean; independent_passed?: boolean; total_passed: number | null; preexisting_files: number | null; agent_added_files: number; agent_cases_added: number };
  criteria: CriterionResult[];
  agreement: { exact: number; total: number; false_verified: number; false_unmet: number; verified_vs_supported: number };
  timings: { agent_s?: number; judge_s?: number; grader_s?: number };
  notes: string[];
}

export function resultsRoot(root = process.cwd()): string {
  return path.join(root, 'eval', 'results');
}

export function writeResult(r: EvalRunResult, root = process.cwd()): string {
  const dir = path.join(resultsRoot(root), r.task.class);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${r.date.slice(0, 10)}-${r.task.id}-${r.run_id}.json`);
  fs.writeFileSync(file, JSON.stringify(r, null, 2) + '\n');
  const line = { run_id: r.run_id, date: r.date, tally: r.tally, task: { id: r.task.id, class: r.task.class }, agent: r.agent, grader: { model: r.grader.model }, agreement: r.agreement, tally_summary: r.tally_summary, grader_verdict: r.grader_verdict, cost_usd: r.agent.cost_usd, file: path.relative(root, file).replace(/\\/g, '/') };
  fs.appendFileSync(path.join(resultsRoot(root), 'ledger.jsonl'), JSON.stringify(line) + '\n');
  return file;
}

export interface LedgerLine {
  run_id: string;
  date: string;
  tally: { version: string; commit?: string };
  task: { id: string; class: 'fixture' | 'real' | 'historical' };
  agent: { product: string; model?: string; cost_usd?: number | null };
  agreement: EvalRunResult['agreement'];
  tally_summary: EvalRunResult['tally_summary'];
  grader_verdict?: string;
  file: string;
}

export function readLedger(root = process.cwd()): LedgerLine[] {
  const f = path.join(resultsRoot(root), 'ledger.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LedgerLine);
}

/* Aggregate by class and Tally version; never one headline number. */
export function aggregate(lines: LedgerLine[]): Array<{ class: string; version: string; runs: number; criteria: number; exact: number; false_verified: number; false_unmet: number; verified_vs_supported: number; verdict_agreement: number; verdict_n: number; cost_usd: number }> {
  const groups = new Map<string, LedgerLine[]>();
  for (const l of lines) {
    const k = `${l.task.class}|${l.tally.version}`;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  return [...groups.entries()]
    .map(([k, ls]) => {
      const [cls, version] = k.split('|');
      const sum = (f: (l: LedgerLine) => number) => ls.reduce((s, l) => s + f(l), 0);
      const withVerdict = ls.filter((l) => l.grader_verdict);
      return {
        class: cls!,
        version: version!,
        runs: ls.length,
        criteria: sum((l) => l.agreement.total),
        exact: sum((l) => l.agreement.exact),
        false_verified: sum((l) => l.agreement.false_verified),
        false_unmet: sum((l) => l.agreement.false_unmet),
        verified_vs_supported: sum((l) => l.agreement.verified_vs_supported),
        verdict_agreement: withVerdict.filter((l) => l.grader_verdict === l.tally_summary.verdict).length,
        verdict_n: withVerdict.length,
        cost_usd: sum((l) => l.agent.cost_usd ?? 0),
      };
    })
    .sort((a, b) => a.class.localeCompare(b.class) || a.version.localeCompare(b.version));
}
