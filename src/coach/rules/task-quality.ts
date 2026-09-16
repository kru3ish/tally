import type { Rule, Suggestion } from '../types.js';
import { postTools } from '../helpers.js';

export const taskQuality: Rule = {
  id: 'task-quality',
  describe: 'The session has no linked task, or the spec-quality score is low',
  evaluate(ctx) {
    const out: Suggestion[] = [];
    const prompts = ctx.events.filter((e) => e.type === 'prompt');
    if (!ctx.task) {
      if (prompts.length >= 1 && postTools(ctx).length >= 3) {
        out.push({
          rule: this.id,
          key: 'no-task',
          severity: 'info',
          title: 'No task linked',
          message: 'Nothing is linked to this session, so the receipt will judge against the first prompt only. Link the ticket: `tally task <url|path|text>` (a URL in the first prompt is picked up automatically).',
          usd_saved: 0,
          action: { kind: 'none', label: 'Run tally task <ref> in another terminal' },
        });
      }
      return out;
    }
    if (ctx.task.needs_clarification) {
      const qs = ctx.task.spec_quality.questions.slice(0, 4);
      out.push({
        rule: this.id,
        key: `vague:${ctx.task.spec_quality.score}`,
        severity: 'warn',
        title: `Clarify the ticket first (spec quality ${ctx.task.spec_quality.score}/10)`,
        message: `"${ctx.task.title}" scored ${ctx.task.spec_quality.score}/10 at intake. Missing: ${ctx.task.spec_quality.missing.join('; ') || 'details'}. Building on a vague spec is the most expensive kind of rework.${qs.length ? '\n  Ask: ' + qs.map((q) => `\n   - ${q}`).join('') : ''}`,
        usd_saved: ctx.task.budget_usd * 0.3,
        action: { kind: 'inject', label: 'Have Claude ask the questions before building', note: `The task spec is vague (${ctx.task.spec_quality.score}/10). Before writing code, ask the user these questions and wait for answers: ${qs.join(' | ')}` },
      });
    }
    return out;
  },
};
