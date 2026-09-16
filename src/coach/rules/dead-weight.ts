import type { Rule, RuleContext, Suggestion } from '../types.js';
import { priceFor } from '../../cost/pricing.js';
import type { HistoryEntry } from '../types.js';

export const REMOVE_AFTER_UNUSED_SESSIONS = 10;

export interface DeadWeightItem {
  kind: 'mcp' | 'skill';
  name: string;
  loaded_in: number;
  unused_streak: number;
  overhead_tokens: number;
  basis: 'measured' | 'estimated';
  compared: { with: number; without: number };
  usd_per_session: number;
  recommendation: 'remove' | 'watch';
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function loads(h: HistoryEntry, kind: 'mcp' | 'skill', name: string): boolean {
  const arr = kind === 'mcp' ? h.loaded?.mcp : h.loaded?.skills;
  return (arr ?? []).some((x) => x.toLowerCase() === name.toLowerCase());
}

function uses(h: HistoryEntry, kind: 'mcp' | 'skill', name: string): boolean {
  const arr = kind === 'mcp' ? h.used?.mcp : h.used?.skills;
  return (arr ?? []).some((x) => (kind === 'mcp' ? x.toLowerCase() === name.toLowerCase() : x.toLowerCase().includes(name.toLowerCase())));
}

/* Per-item overhead is *measured* when the repo's history holds sessions both with and without the item loaded
   (first-turn token delta between the two groups). Otherwise it is an even share of the overhead above baseline,
   labelled estimated. Removal is only recommended when measured, or after 10+ unused sessions. */
export function findDeadWeight(ctx: RuleContext, minSessions = 3): { items: DeadWeightItem[]; sessions: number; avg_first_turn: number; overhead: number } {
  const repo = ctx.cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const all = ctx.history.filter((h) => h.kind === 'session' && !h.internal && h.repo === repo && h.loaded && typeof h.first_turn_tokens === 'number');
  const recent = all.slice(-ctx.cfg.dead_weight_sessions);
  if (recent.length < minSessions) return { items: [], sessions: recent.length, avg_first_turn: 0, overhead: 0 };
  const avgFirst = mean(recent.map((h) => h.first_turn_tokens ?? 0));
  const overhead = Math.max(0, avgFirst - ctx.cfg.baseline_context_tokens);
  const model = ctx.transcript?.messages.find((m) => m.agent === 'main')?.model;
  const price = priceFor(model);
  const avgMsgs = ctx.transcript ? ctx.transcript.messages.filter((m) => m.agent === 'main').length || 20 : 20;
  const candidates: Array<{ kind: 'mcp' | 'skill'; name: string }> = [];
  for (const h of recent) {
    for (const m of h.loaded?.mcp ?? []) if (!candidates.some((c) => c.kind === 'mcp' && c.name === m)) candidates.push({ kind: 'mcp', name: m });
    for (const s of h.loaded?.skills ?? []) if (!candidates.some((c) => c.kind === 'skill' && c.name === s)) candidates.push({ kind: 'skill', name: s });
  }
  const totalItems = candidates.length || 1;
  const items: DeadWeightItem[] = [];
  for (const c of candidates) {
    const loadedRecent = recent.filter((h) => loads(h, c.kind, c.name));
    if (loadedRecent.length < minSessions) continue;
    if (loadedRecent.some((h) => uses(h, c.kind, c.name))) continue;
    let streak = 0;
    for (let i = all.length - 1; i >= 0; i--) {
      const h = all[i]!;
      if (!loads(h, c.kind, c.name)) continue;
      if (uses(h, c.kind, c.name)) break;
      streak += 1;
    }
    const withIt = all.filter((h) => loads(h, c.kind, c.name)).map((h) => h.first_turn_tokens ?? 0);
    const withoutIt = all.filter((h) => !loads(h, c.kind, c.name)).map((h) => h.first_turn_tokens ?? 0);
    let basis: 'measured' | 'estimated';
    let tokens: number;
    if (withIt.length && withoutIt.length) {
      basis = 'measured';
      tokens = Math.max(0, Math.round(mean(withIt) - mean(withoutIt)));
    } else {
      basis = 'estimated';
      tokens = Math.round(overhead / totalItems);
    }
    const usd = (tokens * price.cache_write_1h + tokens * price.cache_read * avgMsgs) / 1e6;
    items.push({
      kind: c.kind,
      name: c.name,
      loaded_in: loadedRecent.length,
      unused_streak: streak,
      overhead_tokens: tokens,
      basis,
      compared: { with: withIt.length, without: withoutIt.length },
      usd_per_session: usd,
      recommendation: basis === 'measured' || streak >= REMOVE_AFTER_UNUSED_SESSIONS ? 'remove' : 'watch',
    });
  }
  items.sort((a, b) => (a.recommendation === b.recommendation ? b.usd_per_session - a.usd_per_session : a.recommendation === 'remove' ? -1 : 1));
  return { items, sessions: recent.length, avg_first_turn: Math.round(avgFirst), overhead: Math.round(overhead) };
}

export const deadWeight: Rule = {
  id: 'dead-weight',
  describe: 'A skill or MCP server is loaded but unused across recent sessions',
  evaluate(ctx) {
    const dw = findDeadWeight(ctx);
    if (!dw.items.length) return [];
    const out: Suggestion[] = [];
    for (const item of dw.items.slice(0, 3)) {
      const measure =
        item.basis === 'measured'
          ? `Measured: first turns in this repo run ${item.overhead_tokens.toLocaleString()} tokens higher with "${item.name}" loaded than without it (${item.compared.with} vs ${item.compared.without} sessions), about $${item.usd_per_session.toFixed(2)} per session.`
          : `Estimated: the first turn loads ${dw.avg_first_turn.toLocaleString()} tokens on average, ${dw.overhead.toLocaleString()} above baseline, shared evenly by everything loaded; "${item.name}"'s even share is ~${item.overhead_tokens.toLocaleString()} tokens (~$${item.usd_per_session.toFixed(2)} per session). No session without it exists yet to measure the real delta.`;
      const remove = item.recommendation === 'remove';
      const removal = item.kind === 'mcp' ? `claude mcp remove ${item.name}` : `claude plugin disable <plugin providing ${item.name}>   # or delete .claude/skills/${item.name}`;
      out.push({
        rule: this.id,
        key: `dead:${item.kind}:${item.name}:${item.recommendation}`,
        severity: 'info',
        title: `${item.kind} "${item.name}" unused for ${item.unused_streak} session${item.unused_streak === 1 ? '' : 's'} (${item.basis}${remove ? ', remove' : ', watch'})`,
        message: `${measure} ${remove ? 'Recommendation: remove it, or run `tally experiment start ' + item.kind + ' ' + item.name + ' --tasks 6` to measure its effect on outcomes.' : `Recommendation: watch. Removal is suggested once the overhead is measured or after ${REMOVE_AFTER_UNUSED_SESSIONS} unused sessions (${item.unused_streak} so far).`}`,
        usd_saved: item.usd_per_session,
        action: remove
          ? { kind: 'snippet', label: 'Show the removal command', snippet: removal, where: 'settings change: run it yourself; Tally never edits MCP or plugin config automatically' }
          : { kind: 'none', label: `Watching; ${REMOVE_AFTER_UNUSED_SESSIONS - item.unused_streak} more unused session(s) or one session without it will settle this` },
      });
    }
    return out;
  },
};
