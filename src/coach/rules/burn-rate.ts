import type { Rule, Suggestion } from '../types.js';
import { minutesAgo, postTools, toolName } from '../helpers.js';

/* 0.1.1: 8 of 32 replayed burn-rate suggestions were marked useful, so the bar is higher: $3 in 15 minutes over 10+ calls
   with no edit, and at most one such note per 30 minutes */
export const BURN_WINDOW_MIN = 15;
export const BURN_MIN_USD = 3;
export const BURN_MIN_CALLS = 10;
export const BURN_REPEAT_MIN = 30;

export const burnRate: Rule = {
  id: 'burn-rate',
  describe: 'Spend is high while no files change, or spend passed 80% / 100% of the task budget',
  evaluate(ctx) {
    const out: Suggestion[] = [];
    const t = ctx.transcript;
    if (t) {
      const since = minutesAgo(ctx, BURN_WINDOW_MIN);
      const recent = t.messages.filter((m) => m.agent === 'main' && m.ts >= since);
      const spent = recent.reduce((s, m) => s + m.cost, 0);
      const edits = postTools(ctx).filter((e) => e.ts >= since && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName(e))).length;
      const calls = postTools(ctx).filter((e) => e.ts >= since).length;
      if (spent >= BURN_MIN_USD && edits === 0 && calls >= BURN_MIN_CALLS) {
        out.push({
          rule: this.id,
          key: `burn:${Math.floor(ctx.now.getTime() / (BURN_REPEAT_MIN * 60000))}`,
          severity: 'warn',
          title: `$${spent.toFixed(2)} in ${BURN_WINDOW_MIN} min, no file changed`,
          message: `The last ${BURN_WINDOW_MIN} minutes cost $${spent.toFixed(2)} across ${calls} tool calls without a single edit. That is exploration or thrashing. Narrow the question or give Claude the file names.`,
          usd_saved: spent / 2,
          action: { kind: 'inject', label: 'Ask Claude to commit to a plan', note: `Tally observed ${calls} tool calls and $${spent.toFixed(2)} of spend in the last ${BURN_WINDOW_MIN} minutes with no file edited.` },
        });
      }
    }
    const task = ctx.task;
    if (task && task.budget_usd > 0 && ctx.spendUsd > 0) {
      const pct = (ctx.spendUsd / task.budget_usd) * 100;
      if (pct >= 100) {
        out.push({
          rule: this.id,
          key: 'budget:100',
          severity: 'critical',
          title: `Over budget: $${ctx.spendUsd.toFixed(2)} of $${task.budget_usd.toFixed(2)}`,
          message: `Spend has passed the intake budget for "${task.title}" (${pct.toFixed(0)}%). The budget was 25% of the human-equivalent value; beyond it the ROI verdict turns borderline. Wrap up or re-scope.`,
          usd_saved: ctx.avgTurnCostUsd * 5,
          action: { kind: 'inject', label: 'Tell Claude to wrap up', note: `Tally observed session spend of $${ctx.spendUsd.toFixed(2)} against the task's $${task.budget_usd.toFixed(2)} budget set at intake (${pct.toFixed(0)}%).` },
        });
      } else if (pct >= 80) {
        out.push({
          rule: this.id,
          key: 'budget:80',
          severity: 'warn',
          title: `${pct.toFixed(0)}% of budget used`,
          message: `$${ctx.spendUsd.toFixed(2)} of the $${task.budget_usd.toFixed(2)} budget is spent. ${task.criteria.length} criteria were frozen at intake; check which are done before spending more.`,
          usd_saved: ctx.avgTurnCostUsd * 3,
          action: { kind: 'inject', label: 'Ask for a criteria checkpoint', note: `Tally observed session spend at ${pct.toFixed(0)}% of the $${task.budget_usd.toFixed(2)} budget; the ${task.criteria.length} acceptance criteria frozen at intake are: ${task.criteria.map((c) => c.text).join('; ')}.` },
        });
      }
    }
    return out;
  },
};
