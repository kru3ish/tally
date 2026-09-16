import path from 'node:path';
import type { Rule, RuleContext, Suggestion } from '../types.js';
import { postTools, shortPath, toolInput, toolName } from '../helpers.js';
import { priceFor } from '../../cost/pricing.js';

export function buildHandoff(ctx: RuleContext): string {
  const task = ctx.task;
  const edits = [...new Set(postTools(ctx).filter((e) => ['Edit', 'Write', 'MultiEdit'].includes(toolName(e))).map((e) => shortPath(String(toolInput(e).file_path ?? ''), ctx.cwd)))];
  const lastStop = [...ctx.events].reverse().find((e) => e.type === 'stop');
  const lastPrompt = [...ctx.events].reverse().find((e) => e.type === 'prompt');
  const tests = postTools(ctx).filter((e) => toolName(e) === 'Bash' && /test|vitest|pytest|jest/.test(String(toolInput(e).command ?? ''))).slice(-1)[0];
  const L: string[] = [];
  L.push(`# HANDOFF (written by Tally at ${ctx.now.toISOString()})`);
  L.push('');
  L.push('## Goal');
  L.push(task ? `${task.title}${task.source.url ? ` (${task.source.url})` : ''}` : lastPrompt ? String(lastPrompt.data.prompt ?? '').slice(0, 400) : '(no linked task)');
  if (task?.criteria.length) {
    L.push('');
    L.push('Acceptance criteria:');
    for (const c of task.criteria) L.push(`- [ ] ${c.text}`);
  }
  L.push('');
  L.push('## State');
  L.push(edits.length ? `Files touched this session: ${edits.join(', ')}` : 'No files edited yet.');
  if (tests) L.push(`Last test run: \`${String(toolInput(tests).command)}\` → ${tests.data.is_error ? 'failing' : 'passing'}`);
  if (lastStop) L.push(`Last assistant summary: ${String(lastStop.data.last_assistant_message ?? '').slice(0, 600)}`);
  L.push('');
  L.push('## Next steps');
  L.push('- Re-read this file after /compact, then continue from the unchecked criteria above.');
  if (tests?.data.is_error) L.push('- Fix the failing test before adding anything new.');
  L.push('');
  return L.join('\n');
}

export const contextPressure: Rule = {
  id: 'context-pressure',
  describe: 'Context passes 70% (warn) or 85% (critical)',
  evaluate(ctx) {
    if (!ctx.contextTokensNow || !ctx.contextWindow) return [];
    const pct = (ctx.contextTokensNow / ctx.contextWindow) * 100;
    const warn = ctx.cfg.coach.context_warn_pct;
    const crit = ctx.cfg.coach.context_critical_pct;
    if (pct < warn) return [];
    const level = pct >= crit ? crit : warn;
    const model = ctx.transcript?.messages.find((m) => m.agent === 'main')?.model;
    const price = priceFor(model);
    const recacheUsd = (ctx.contextTokensNow * price.cache_write_1h) / 1e6;
    const s: Suggestion = {
      rule: this.id,
      key: `context:${level}`,
      severity: pct >= crit ? 'critical' : 'warn',
      title: `Context at ${pct.toFixed(0)}%`,
      message: `Context is ${ctx.contextTokensNow.toLocaleString()} of ${ctx.contextWindow.toLocaleString()} tokens (${pct.toFixed(0)}%). Auto-compact will lose working state. Write HANDOFF.md now, then run /compact on your terms. Re-caching after compaction costs about $${recacheUsd.toFixed(2)}.`,
      usd_saved: recacheUsd + ctx.avgTurnCostUsd * 2,
      action: { kind: 'write_md', label: 'Write HANDOFF.md, then suggest /compact', file: path.join(ctx.cwd, 'HANDOFF.md'), content: buildHandoff(ctx), mode: 'replace' },
      inject_note: `Tally observed the context at ${pct.toFixed(0)}% of the window; HANDOFF.md in the repo root now holds the goal, current state, and next steps as of ${ctx.now.toISOString().slice(11, 16)} UTC.`,
    };
    return [s];
  },
};
