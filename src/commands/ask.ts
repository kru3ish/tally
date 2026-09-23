/* `tally ask "<question>"`: a natural-language question over the receipts, answered by the small model from a
   numbers-only evidence pack (the same rows `tally export` produces, plus the trend) with the session ids it relied on.
   Nothing from prompts or code is sent unless --titles adds task titles. */
import { type Args, has } from '../cli.js';
import { loadConfig } from '../config.js';
import { makeLlm } from '../llm/client.js';
import { loadHistory } from '../coach/context.js';
import { exportRow } from './export.js';
import { computeTrend } from '../report/report.js';

export const ASK_SYSTEM = `You answer an engineer's question about their Claude Code usage from Tally receipts. Each receipt row has numbers, statuses and outcomes for one task (a session). Use only the rows given; when the data cannot answer, say so and say what would. Cite the session ids (first 8 characters) behind each claim. Be concrete and short: numbers, not adjectives. Return only the JSON object.`;

export const ASK_SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' }, sessions: { type: 'array', items: { type: 'string' } }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] } },
  required: ['answer', 'sessions', 'confidence'],
} as const;

export async function run(args: Args): Promise<number | void> {
  const question = args._.join(' ').trim();
  if (!question) {
    process.stderr.write('Usage: tally ask "why did spend jump in August?" [--titles] [--since 90d]\n');
    return 1;
  }
  const cfg = loadConfig();
  const history = loadHistory().filter((e) => e.verdict && !e.internal);
  if (!history.length) {
    process.stdout.write('No receipts yet to answer from. Judge a few tasks, or run tally backfill add.\n');
    return;
  }
  const rows = history.slice(-200).map((e) => exportRow(e, has(args, 'titles')));
  const trend = computeTrend({ history });
  const pack = `QUESTION: ${question}\n\nTREND (all receipts): ${JSON.stringify({ tasks: trend.tasks, cost_per_task_usd: trend.cost_per_task_usd, completion_pct: trend.completion_pct, rework_rate: trend.rework_rate, verdicts: trend.verdicts, abstained: trend.abstained, by_task_source: trend.by_task_source })}\n\nRECEIPTS (newest last, one JSON per line):\n${rows.map((r) => JSON.stringify(r)).join('\n')}`;
  const llm = makeLlm({ session: 'ask' });
  const r = await llm.complete<{ answer: string; sessions: string[]; confidence: string }>({ kind: 'coach', model: cfg.models.coach, system: ASK_SYSTEM, prompt: pack, schema: ASK_SCHEMA as unknown as Record<string, unknown> });
  process.stdout.write(`${r.data.answer}\n\n(${r.data.confidence} confidence · ${rows.length} receipt(s) consulted · sessions: ${(r.data.sessions ?? []).map((s) => s.slice(0, 8)).join(', ') || 'none cited'} · Tally spend $${r.cost_usd.toFixed(3)})\n`);
}
