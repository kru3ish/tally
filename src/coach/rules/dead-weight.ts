import type { Rule, RuleContext, Suggestion } from '../types.js';
import { priceFor } from '../../cost/pricing.js';

export interface DeadWeightItem {
  kind: 'mcp' | 'skill';
  name: string;
  sessions: number;
  share_tokens: number;
  usd_per_session: number;
}

export function findDeadWeight(ctx: RuleContext, minSessions = 3): { items: DeadWeightItem[]; sessions: number; avg_first_turn: number; overhead: number } {
  const repo = ctx.cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const sessions = ctx.history.filter((h) => h.kind === 'session' && h.repo === repo && h.loaded).slice(-ctx.cfg.dead_weight_sessions);
  if (sessions.length < minSessions) return { items: [], sessions: sessions.length, avg_first_turn: 0, overhead: 0 };
  const avgFirst = sessions.reduce((s, h) => s + (h.first_turn_tokens ?? 0), 0) / sessions.length;
  const overhead = Math.max(0, avgFirst - ctx.cfg.baseline_context_tokens);
  const loadedMcp = new Set<string>();
  const loadedSkills = new Set<string>();
  for (const h of sessions) {
    for (const m of h.loaded?.mcp ?? []) loadedMcp.add(m);
    for (const s of h.loaded?.skills ?? []) loadedSkills.add(s);
  }
  const model = ctx.transcript?.messages.find((m) => m.agent === 'main')?.model;
  const price = priceFor(model);
  const avgMsgs = ctx.transcript ? ctx.transcript.messages.filter((m) => m.agent === 'main').length || 20 : 20;
  const totalItems = loadedMcp.size + loadedSkills.size || 1;
  const share = overhead / totalItems;
  const usdPerSession = (share * price.cache_write_1h + share * price.cache_read * avgMsgs) / 1e6;
  const items: DeadWeightItem[] = [];
  for (const m of loadedMcp) {
    const everUsed = sessions.some((h) => (h.used?.mcp ?? []).some((u) => u.toLowerCase() === m.toLowerCase()));
    const loadedIn = sessions.filter((h) => (h.loaded?.mcp ?? []).includes(m)).length;
    if (!everUsed && loadedIn >= minSessions) items.push({ kind: 'mcp', name: m, sessions: loadedIn, share_tokens: Math.round(share), usd_per_session: usdPerSession });
  }
  for (const s of loadedSkills) {
    const everUsed = sessions.some((h) => (h.used?.skills ?? []).some((u) => u.toLowerCase().includes(s.toLowerCase())));
    const loadedIn = sessions.filter((h) => (h.loaded?.skills ?? []).includes(s)).length;
    if (!everUsed && loadedIn >= minSessions) items.push({ kind: 'skill', name: s, sessions: loadedIn, share_tokens: Math.round(share), usd_per_session: usdPerSession });
  }
  return { items, sessions: sessions.length, avg_first_turn: Math.round(avgFirst), overhead: Math.round(overhead) };
}

export const deadWeight: Rule = {
  id: 'dead-weight',
  describe: 'A skill or MCP server is loaded but unused across recent sessions',
  evaluate(ctx) {
    const dw = findDeadWeight(ctx);
    if (!dw.items.length) return [];
    const out: Suggestion[] = [];
    for (const item of dw.items.slice(0, 3)) {
      out.push({
        rule: this.id,
        key: `dead:${item.kind}:${item.name}`,
        severity: 'info',
        title: `${item.kind} "${item.name}" unused in the last ${item.sessions} sessions`,
        message: `Measured: the first turn in this repo loads ${dw.avg_first_turn.toLocaleString()} tokens on average, ${dw.overhead.toLocaleString()} above baseline, shared by everything loaded. "${item.name}" is never called; its share is ~${item.share_tokens.toLocaleString()} tokens, about $${item.usd_per_session.toFixed(2)} per session. Remove it, or run \`tally experiment start ${item.kind} ${item.name} --tasks 6\` to measure it properly.`,
        usd_saved: item.usd_per_session,
        action: {
          kind: 'snippet',
          label: 'Show the removal command',
          snippet: item.kind === 'mcp' ? `claude mcp remove ${item.name}` : `claude plugin disable <plugin providing ${item.name}>   # or delete .claude/skills/${item.name}`,
          where: 'settings change: run it yourself; Tally never edits MCP or plugin config automatically',
        },
      });
    }
    return out;
  },
};
