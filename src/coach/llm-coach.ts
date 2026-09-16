import type { LlmClient } from '../llm/client.js';
import type { RuleContext, Suggestion } from './types.js';
import { toolInput, toolName } from './helpers.js';

export const COACH_SYSTEM = `You are a terse pair-programming coach watching a Claude Code session from the outside. You see the task's acceptance criteria and the last few tool calls.
Return at most ONE suggestion, and only if it would clearly save money or prevent rework right now. Otherwise return has_suggestion=false. Never restate what the deterministic rules already cover: loops, re-reads, context size, budget, MCP errors, missing CLAUDE.md.
Good suggestions: a criterion is being ignored, the approach contradicts the ticket, tests are being skipped, scope is creeping, a simpler path exists.
usd_saved is your honest estimate in dollars. Keep message under 40 words. inject_note is what to tell Claude, in the second person, under 60 words.`;

export const COACH_SCHEMA = {
  type: 'object',
  properties: {
    has_suggestion: { type: 'boolean' },
    title: { type: 'string' },
    message: { type: 'string' },
    inject_note: { type: 'string' },
    severity: { type: 'string', enum: ['info', 'warn'] },
    usd_saved: { type: 'number' },
  },
  required: ['has_suggestion'],
} as const;

interface CoachOut {
  has_suggestion: boolean;
  title?: string;
  message?: string;
  inject_note?: string;
  severity?: 'info' | 'warn';
  usd_saved?: number;
}

export function summarizeRecent(ctx: RuleContext, n = 15): string {
  const recent = ctx.events.filter((e) => e.type === 'post_tool' || e.type === 'prompt' || e.type === 'stop').slice(-n);
  return recent
    .map((e) => {
      if (e.type === 'prompt') return `USER: ${String(e.data.prompt ?? '').slice(0, 200)}`;
      if (e.type === 'stop') return `CLAUDE: ${String(e.data.last_assistant_message ?? '').slice(0, 200)}`;
      const inp = toolInput(e);
      const what = inp.command ?? inp.file_path ?? inp.pattern ?? inp.url ?? '';
      return `${toolName(e)} ${String(what).slice(0, 120)}${e.data.is_error ? ' -> ERROR' : ''}`;
    })
    .join('\n');
}

export async function llmCoach(ctx: RuleContext, llm: LlmClient): Promise<Suggestion | null> {
  const criteria = ctx.task?.criteria.map((c) => `- ${c.id}: ${c.text}`).join('\n') ?? '(no linked task)';
  const prompt = `TASK: ${ctx.task?.title ?? '(none)'}\nCRITERIA:\n${criteria}\n\nSPEND SO FAR: $${ctx.spendUsd.toFixed(2)} of $${ctx.task?.budget_usd.toFixed(2) ?? '?'}\n\nRECENT ACTIVITY (oldest first):\n${summarizeRecent(ctx)}`;
  const r = await llm.complete<CoachOut>({ kind: 'coach', model: ctx.cfg.models.coach, system: COACH_SYSTEM, prompt, schema: COACH_SCHEMA as unknown as Record<string, unknown>, timeoutMs: 60000 });
  const o = r.data;
  if (!o?.has_suggestion || !o.message) return null;
  return {
    rule: 'llm-coach',
    key: `llm:${(o.title ?? o.message).slice(0, 40)}`,
    severity: o.severity === 'warn' ? 'warn' : 'info',
    title: o.title ?? 'Coach',
    message: o.message,
    usd_saved: Math.max(0, Number(o.usd_saved ?? 0)),
    action: { kind: 'inject', label: 'Tell Claude', note: o.inject_note ?? o.message },
  };
}
