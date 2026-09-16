import { loadHistory } from '../coach/context.js';
import type { HistoryEntry } from '../coach/types.js';
import { fmtUsd } from '../cost/pricing.js';
import { loadExperiments } from '../experiment/experiment.js';
import { buildReport, renderExperimentReport } from '../experiment/report.js';

export interface Trend {
  tasks: number;
  sessions: number;
  cost_per_task_usd: number | null;
  cost_per_criterion_usd: number | null;
  completion_pct: number | null;
  rework_rate: number | null;
  followed_up: number;
  waste_usd: number | null;
  linked_rate: number | null;
  verdicts: Record<string, number>;
  recent_vs_prior: { recent_cost: number | null; prior_cost: number | null; recent_completion: number | null; prior_completion: number | null } | null;
  payoff: Array<{ kind: 'skill' | 'mcp'; name: string; used_in: number; completion_with: number | null; completion_without: number | null; cpc_with: number | null; cpc_without: number | null }>;
  top_recommendations: Array<{ text: string; count: number }>;
  by_task_source: Array<{ source: string; tasks: number; completion_pct: number | null; cost_per_task_usd: number | null; rework_rate: number | null }>;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function latestReceipts(entries: HistoryEntry[]): HistoryEntry[] {
  const bySession = new Map<string, HistoryEntry>();
  for (const e of entries) if (e.verdict && e.session) bySession.set(e.session, e);
  return [...bySession.values()].sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
}

export function computeTrend(opts: { repo?: string; days?: number; history?: HistoryEntry[] } = {}): Trend {
  const all = opts.history ?? loadHistory();
  const cutoff = opts.days ? Date.now() - opts.days * 86400000 : 0;
  const inScope = all.filter((e) => !e.internal && (!opts.repo || e.repo === opts.repo) && (!cutoff || Date.parse(e.ts ?? '') >= cutoff));
  const receipts = latestReceipts(inScope);
  const sessions = inScope.filter((e) => e.kind === 'session');
  const followed = receipts.filter((r) => r.final_status && r.final_status !== 'unknown');
  const verdicts: Record<string, number> = {};
  for (const r of receipts) verdicts[r.final_verdict ?? r.verdict ?? '?'] = (verdicts[r.final_verdict ?? r.verdict ?? '?'] ?? 0) + 1;

  const half = Math.floor(receipts.length / 2);
  const prior = receipts.slice(0, half);
  const recent = receipts.slice(half);

  const names = new Map<string, { kind: 'skill' | 'mcp'; with: HistoryEntry[]; without: HistoryEntry[] }>();
  for (const r of receipts) {
    const used = new Set([...(r.skills ?? []).map((s) => `skill:${s}`), ...(r.mcp ?? []).map((m) => `mcp:${m.split(':')[0]}`)]);
    for (const k of used) names.set(k, names.get(k) ?? { kind: k.startsWith('skill') ? 'skill' : 'mcp', with: [], without: [] });
  }
  for (const [k, v] of names) {
    for (const r of receipts) {
      const used = new Set([...(r.skills ?? []).map((s) => `skill:${s}`), ...(r.mcp ?? []).map((m) => `mcp:${m.split(':')[0]}`)]);
      (used.has(k) ? v.with : v.without).push(r);
    }
  }
  const payoff = [...names.entries()]
    .map(([k, v]) => ({
      kind: v.kind,
      name: k.split(':').slice(1).join(':'),
      used_in: v.with.length,
      completion_with: mean(v.with.map((r) => r.completion_pct ?? 0)),
      completion_without: mean(v.without.map((r) => r.completion_pct ?? 0)),
      cpc_with: mean(v.with.map((r) => r.per_criterion_usd).filter((x): x is number => typeof x === 'number')),
      cpc_without: mean(v.without.map((r) => r.per_criterion_usd).filter((x): x is number => typeof x === 'number')),
    }))
    .sort((a, b) => b.used_in - a.used_in);

  const recCount = new Map<string, number>();
  for (const r of receipts) for (const rec of r.recommendations ?? []) recCount.set(rec, (recCount.get(rec) ?? 0) + 1);

  return {
    tasks: receipts.length,
    sessions: sessions.length,
    cost_per_task_usd: mean(receipts.map((r) => r.cost_usd ?? 0)),
    cost_per_criterion_usd: mean(receipts.map((r) => r.per_criterion_usd).filter((x): x is number => typeof x === 'number')),
    completion_pct: mean(receipts.map((r) => r.completion_pct ?? 0)),
    rework_rate: followed.length ? followed.filter((r) => r.final_status !== 'held up').length / followed.length : null,
    followed_up: followed.length,
    waste_usd: mean(receipts.map((r) => r.waste_usd ?? 0)),
    linked_rate: receipts.length ? receipts.filter((r) => r.linked).length / receipts.length : null,
    verdicts,
    recent_vs_prior: half > 0 ? { recent_cost: mean(recent.map((r) => r.cost_usd ?? 0)), prior_cost: mean(prior.map((r) => r.cost_usd ?? 0)), recent_completion: mean(recent.map((r) => r.completion_pct ?? 0)), prior_completion: mean(prior.map((r) => r.completion_pct ?? 0)) } : null,
    payoff,
    top_recommendations: [...recCount.entries()].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count).slice(0, 5),
    by_task_source: ['linked', 'confirmed', 'inferred'].map((source) => {
      const rs = receipts.filter((r) => (r.task_source ?? (r.linked ? 'linked' : 'inferred')) === source);
      const fu = rs.filter((r) => r.final_status && r.final_status !== 'unknown');
      return { source, tasks: rs.length, completion_pct: mean(rs.map((r) => r.completion_pct ?? 0)), cost_per_task_usd: mean(rs.map((r) => r.cost_usd ?? 0)), rework_rate: fu.length ? fu.filter((r) => r.final_status !== 'held up').length / fu.length : null };
    }).filter((x) => x.tasks > 0),
  };
}

export function renderTrend(t: Trend, opts: { repo?: string; days?: number } = {}): string {
  const L: string[] = [];
  const f = (x: number | null, fn: (n: number) => string) => (x === null ? 'n/a' : fn(x));
  L.push(`Tally report${opts.repo ? ` · ${opts.repo}` : ' · all repos'}${opts.days ? ` · last ${opts.days} days` : ''}`);
  L.push(`${t.tasks} judged task(s) across ${t.sessions} session(s)`);
  if (!t.tasks) {
    L.push('No receipts yet. Link a task with `tally task <url>` and ship; the receipt appears on push.');
    return L.join('\n');
  }
  L.push('');
  L.push(`cost per task        ${f(t.cost_per_task_usd, fmtUsd)} API-equivalent`);
  L.push(`cost per criterion   ${f(t.cost_per_criterion_usd, fmtUsd)}`);
  L.push(`completion           ${f(t.completion_pct, (n) => n.toFixed(0) + '%')}`);
  L.push(`waste per task       ${f(t.waste_usd, fmtUsd)}`);
  L.push(`rework rate          ${t.rework_rate === null ? `n/a (${t.followed_up} followed up)` : `${(t.rework_rate * 100).toFixed(0)}% of ${t.followed_up} followed up`}`);
  L.push(`tasks linked         ${f(t.linked_rate, (n) => (n * 100).toFixed(0) + '%')}`);
  L.push(`verdicts             ${Object.entries(t.verdicts).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  if (t.recent_vs_prior) {
    const r = t.recent_vs_prior;
    L.push(`trend                cost ${f(r.prior_cost, fmtUsd)} → ${f(r.recent_cost, fmtUsd)}, completion ${f(r.prior_completion, (n) => n.toFixed(0) + '%')} → ${f(r.recent_completion, (n) => n.toFixed(0) + '%')} (older half → newer half)`);
  }
  if (t.by_task_source.length > 1) {
    L.push('');
    L.push('By task source (linked ticket vs inferred from prompts)');
    for (const s of t.by_task_source) L.push(`  ${s.source.padEnd(10)} ${String(s.tasks).padStart(3)} task(s)  completion ${f(s.completion_pct, (n) => n.toFixed(0) + '%')}  cost/task ${f(s.cost_per_task_usd, fmtUsd)}  rework ${f(s.rework_rate, (n) => (n * 100).toFixed(0) + '%')}`);
  }
  if (t.payoff.length) {
    L.push('');
    L.push('Skill / MCP payoff (correlational; run `tally experiment` for a controlled answer)');
    L.push('kind   name                        used  completion with/without   cost per criterion with/without');
    for (const p of t.payoff.slice(0, 12)) {
      L.push(`${p.kind.padEnd(6)} ${p.name.slice(0, 27).padEnd(27)} ${String(p.used_in).padStart(4)}  ${f(p.completion_with, (n) => n.toFixed(0) + '%').padStart(6)} / ${f(p.completion_without, (n) => n.toFixed(0) + '%').padEnd(6)}          ${f(p.cpc_with, fmtUsd).padStart(7)} / ${f(p.cpc_without, fmtUsd)}`);
    }
  }
  if (t.top_recommendations.length) {
    L.push('');
    L.push('Most repeated recommendations');
    for (const r of t.top_recommendations) L.push(`  ${r.count}× ${r.text}`);
  }
  const exps = loadExperiments().experiments.filter((e) => !opts.repo || e.repo === opts.repo);
  if (exps.length) {
    L.push('');
    L.push('Experiments');
    for (const e of exps.slice(-3)) L.push('  ' + renderExperimentReport(buildReport(e)).split('\n').join('\n  '));
  }
  return L.join('\n');
}
