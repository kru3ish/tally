import type { Rule } from '../types.js';

/* An inferred task (no ticket: criteria came from the prompts, branch and commits) is shown once for
   [c]onfirm / [e]dit / [l]ink. Until confirmed the receipt says "inferred task (unconfirmed)". */
export const taskConfirm: Rule = {
  id: 'task-confirm',
  describe: 'Ask the user to confirm, edit, or link an inferred task',
  evaluate(ctx) {
    const t = ctx.task;
    if (!t || !t.inferred || t.confirmed) return [];
    return [
      {
        rule: this.id,
        key: `confirm:${t.cache_key ?? t.title}`,
        severity: 'info',
        title: `Inferred task (unconfirmed): ${t.title}`,
        message: `No ticket was linked, so Tally inferred the task from your prompts${t.context?.branch ? `, branch "${t.context.branch}"` : ''}${t.context?.commits?.length ? ` and ${t.context.commits.length} commit(s)` : ''}:\n${t.criteria.map((c) => `   - ${c.id} ${c.text}`).join('\n')}\n   [c]onfirm keeps them · [e]dit rewrites the task in your words · [l]ink attaches a ticket URL (or: tally task --confirm | --edit "<text>" | --link <url>)`,
        usd_saved: t.budget_usd * 0.1,
        action: { kind: 'confirm', label: 'Confirm these criteria' },
      },
    ];
  },
};
