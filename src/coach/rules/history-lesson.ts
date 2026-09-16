import type { Rule, Suggestion } from '../types.js';

export const historyLesson: Rule = {
  id: 'history-lesson',
  describe: 'Past Judge recommendations and follow-up outcomes relevant to this repo, at session start',
  evaluate(ctx) {
    const repo = ctx.cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const receipts = ctx.history.filter((h) => h.repo === repo && (h.recommendations?.length || h.final_status));
    if (!receipts.length) return [];
    const prompts = ctx.events.filter((e) => e.type === 'prompt').length;
    if (prompts > 1) return [];
    const recent = receipts.slice(-5).reverse();
    const lessons: string[] = [];
    for (const r of recent) {
      if (r.final_status && r.final_status !== 'held up') lessons.push(`"${r.task_title ?? 'a task'}" was judged ${r.verdict} but later ${r.final_status}.`);
      for (const rec of r.recommendations ?? []) if (lessons.length < 3 && !lessons.includes(rec)) lessons.push(rec);
      if (lessons.length >= 3) break;
    }
    if (!lessons.length) return [];
    const reworkRate = receipts.filter((r) => r.final_status && r.final_status !== 'held up').length / receipts.length;
    return [
      {
        rule: this.id,
        key: `history:${receipts.length}`,
        severity: 'info',
        title: `${receipts.length} past receipt${receipts.length === 1 ? '' : 's'} for this repo`,
        message: `Lessons from earlier tasks here${reworkRate > 0 ? ` (${Math.round(reworkRate * 100)}% needed rework or were reverted)` : ''}:\n${lessons.map((l) => `   - ${l}`).join('\n')}`,
        usd_saved: (recent[0]?.waste_usd ?? 0) * 0.5,
        action: { kind: 'inject', label: 'Give Claude these lessons now', note: `Lessons from past receipts in this repo: ${lessons.join(' ')}` },
      },
    ];
  },
};
