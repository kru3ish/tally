/* Tiered judging.
   Tier 0: mechanical checks, no LLM.          Tier 1: small model on judgment criteria, trimmed evidence (~8k tokens).
   Tier 2: strong model, only when the session is expensive, --deep, or Tier 1 was unsure; re-judges only those criteria. */
import type { Config } from '../config.js';
import type { Task } from '../task/intake.js';
import type { Evidence } from './evidence.js';
import { NO_CONSENT_REASON, type VerificationResult } from './verify.js';

export type TierName = 'tier0' | 'tier1' | 'tier2';
export type Status = 'met' | 'partial' | 'unmet' | 'unverifiable';

export interface TierDecision {
  run_tier1: boolean;
  run_tier2: boolean;
  tier2_reasons: string[];
  tier2_criteria: string[];
  escalations: Array<{ id: string; reason: 'low-confidence' | 'verdict-sensitive' | 'correctness' }>;
  explanation: string;
}

export interface Tier1Result {
  id: string;
  status: Status;
  confidence: number;
  /* set by the escalation guard: a partial/unmet call on a correctness criterion counts as ≤ 0.5 */
  adjusted_confidence?: number;
  verdict_sensitive?: boolean;
}

const CORRECTNESS_RE = /\b(bug|fix|fixes|fixed|correct|correctly|behav(?:iou?r)|logic|returns?|handles?|reject|accept|validat|when |should|must|error|edge case|off-by-one|regression|works|calculat|comput|respon(?:d|se)|status code|\d{3}\b)/i;

export function isCorrectnessCriterion(text: string): boolean {
  return CORRECTNESS_RE.test(text);
}

/* Confidence after the guard: the model's own number, capped at 0.5 for a partial/unmet call on a correctness criterion. */
export function guardedConfidence(text: string, status: Status, confidence: number): number {
  if ((status === 'partial' || status === 'unmet') && isCorrectnessCriterion(text)) return Math.min(confidence, 0.5);
  return confidence;
}

const STEP_ORDER: Status[] = ['unmet', 'unverifiable', 'partial', 'met'];

/* Would moving this criterion's status one step (either way) change the verdict? */
export function verdictSensitive(input: { statuses: Record<string, Status>; id: string; verdictOf: (statuses: Record<string, Status>) => string }): boolean {
  const cur = input.verdictOf(input.statuses);
  const idx = STEP_ORDER.indexOf(input.statuses[input.id] ?? 'unverifiable');
  for (const next of [idx - 1, idx + 1]) {
    if (next < 0 || next >= STEP_ORDER.length) continue;
    const moved = { ...input.statuses, [input.id]: STEP_ORDER[next]! };
    if (input.verdictOf(moved) !== cur) return true;
  }
  return false;
}

/* Which tiers run. Pure so it can be unit-tested. */
export function selectTiers(input: { judgmentIds: string[]; sessionCostUsd: number; deep: boolean; deepThreshold: number; confidenceFloor: number; tier1?: Tier1Result[] }): TierDecision {
  const { judgmentIds, sessionCostUsd, deep, deepThreshold, confidenceFloor } = input;
  const run_tier1 = judgmentIds.length > 0;
  const reasons: string[] = [];
  const escalations: TierDecision['escalations'] = [];
  let tier2Criteria: string[] = [];
  if (judgmentIds.length) {
    if (deep) reasons.push('--deep');
    if (sessionCostUsd >= deepThreshold) reasons.push(`session cost $${sessionCostUsd.toFixed(2)} ≥ deepThreshold $${deepThreshold.toFixed(2)}`);
    for (const t of input.tier1 ?? []) {
      const conf = t.adjusted_confidence ?? t.confidence;
      if (t.verdict_sensitive) escalations.push({ id: t.id, reason: 'verdict-sensitive' });
      else if (conf < confidenceFloor && t.adjusted_confidence !== undefined && t.adjusted_confidence < t.confidence) escalations.push({ id: t.id, reason: 'correctness' });
      else if (conf < confidenceFloor) escalations.push({ id: t.id, reason: 'low-confidence' });
    }
    const byReason = (r: TierDecision['escalations'][number]['reason']) => escalations.filter((e) => e.reason === r).map((e) => e.id);
    if (byReason('verdict-sensitive').length) reasons.push(`verdict-sensitive: ${byReason('verdict-sensitive').join(', ')}`);
    if (byReason('correctness').length) reasons.push(`partial/unmet on correctness criteria (confidence capped at 0.5): ${byReason('correctness').join(', ')}`);
    if (byReason('low-confidence').length) reasons.push(`tier 1 confidence below ${confidenceFloor} on ${byReason('low-confidence').join(', ')}`);
    if (reasons.length) tier2Criteria = deep || sessionCostUsd >= deepThreshold ? judgmentIds : [...new Set(escalations.map((e) => e.id))];
  }
  const run_tier2 = tier2Criteria.length > 0;
  const explanation = !judgmentIds.length
    ? 'tier 0 only: every criterion resolved mechanically'
    : run_tier2
      ? `tier 2 on ${tier2Criteria.length} criteria: ${reasons.join('; ')}`
      : `tier 2 skipped: session cost $${sessionCostUsd.toFixed(2)} < $${deepThreshold.toFixed(2)}, no --deep, tier 1 confident (≥ ${confidenceFloor}) and no verdict-sensitive criterion`;
  return { run_tier1, run_tier2, tier2_reasons: reasons, tier2_criteria: tier2Criteria, escalations, explanation };
}

export const TIER1_SYSTEM = `You are a skeptical auditor deciding a few acceptance criteria of a coding session from a short evidence pack.
Evidence hierarchy: independent test run > git diff > tool outputs > the assistant's own words (claims, not evidence).
For each criterion return status met / partial / unmet / unverifiable, one sentence of cited evidence, the files involved, and a confidence from 0 to 1.
Confidence is your honest probability that the status is right given the evidence you saw; use below 0.6 whenever the diff was truncated around the relevant code, the criterion needs behaviour you cannot see, or the claim rests only on the assistant's words.
Also return quality_score (0-10) for the visible code, one-paragraph verdict_reason using the numbers given, and exactly three short recommendations.
Return only the JSON object.`;

/* Escalation re-judge: statuses and confidence only; the prose (quality, verdict reason, recommendations) stays with tier 1
   so the extra call is as short as possible. */
export const ESCALATION_SYSTEM = `You are an independent, skeptical auditor re-checking a few acceptance criteria that a first pass was unsure about or that decide the verdict.
Evidence hierarchy: the independent test run, then the diff, then tool outputs; the assistant's own words are claims.
For each listed criterion return status met / partial / unmet / unverifiable, one sentence of cited evidence, the files involved, and a confidence 0-1. Use "partial" when the work is visibly started but a stated requirement is missing. Use "unverifiable" rather than guessing.
Return only the JSON object with the criteria array; leave quality_score, verdict_reason and recommendations empty.`;

export const TIER_SCHEMA = {
  type: 'object',
  properties: {
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['met', 'partial', 'unmet', 'unverifiable'] },
          evidence: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['id', 'status', 'evidence'],
      },
    },
    quality_score: { type: 'number' },
    quality_reason: { type: 'string' },
    verdict_reason: { type: 'string' },
    recommendations: { type: 'array', items: { type: 'string' } },
  },
  /* only `criteria` is hard-required: a strict schema made some models exhaust the structured-output retries */
  required: ['criteria'],
} as const;

export function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/* A diff trimmed to the hunks most likely to matter for the given criteria (files named in criteria or check specs
   first, then the rest), cut at a character budget. */
export function trimDiff(diff: string, prioritizedFiles: string[], maxChars: number): { text: string; truncated: boolean } {
  if (diff.length <= maxChars) return { text: diff, truncated: false };
  const parts = diff.split(/(?=^diff --git )/m);
  const score = (p: string) => {
    const header = p.split('\n')[0] ?? '';
    return prioritizedFiles.some((f) => f && header.toLowerCase().includes(f.replace(/\\/g, '/').toLowerCase().split('/').pop() ?? '')) ? 0 : 1;
  };
  parts.sort((a, b) => score(a) - score(b));
  let out = '';
  let truncated = false;
  for (const p of parts) {
    if (out.length + p.length > maxChars) {
      const room = maxChars - out.length;
      if (room > 400) out += p.slice(0, room) + '\n…[hunk truncated]\n';
      truncated = true;
      break;
    }
    out += p;
  }
  return { text: out, truncated };
}

export function buildTier1Prompt(task: Task, ids: string[], ev: Evidence, ver: VerificationResult, numbers: { cost: number; waste: number; value: number; budget: number }, tokenBudget: number, hints?: Map<string, string>): { prompt: string; tokens: number; truncated: boolean } {
  const criteria = task.criteria.filter((c) => ids.includes(c.id)).map((c) => (hints?.has(c.id) ? { ...c, text: `${c.text}  (a mechanical pattern check did not match: ${hints.get(c.id)}; decide from the diff and tests, the pattern may simply be too narrow)` } : c));
  const prioritized = [...new Set([...ev.edited_files, ...criteria.flatMap((c) => (c.text.match(/[\w./-]+\.[a-z]{1,5}\b/g) ?? []))])];
  const noConsent = !ver.ran && ver.reason === NO_CONSENT_REASON;
  const verLine = ver.ran
    ? `\`${ver.command}\` → ${ver.passed ? 'PASSED' : ver.timed_out ? 'TIMED OUT' : `FAILED (exit ${ver.exit_code})`}\n${(ver.output_tail ?? '').split('\n').slice(-8).join('\n')}`
    : `not run: ${ver.reason}.${noConsent ? ' The user has not allowed the auditor to run tests in this repo. Any criterion about tests passing or coverage can only be "unverifiable" unless the diff itself proves it; transcript claims of passing tests do not count.' : ''}`;
  const head = [`# TASK: ${task.title}`, `## Criteria to decide`, ...criteria.map((c) => `- ${c.id}: ${c.text}`), '', `# INDEPENDENT VERIFICATION (test run by the auditor, not the assistant)`, verLine, '', `# SHIP EVENTS: ${ev.ship_events.map((s) => s.kind).join(', ') || 'none'}`, `# FILES CHANGED (${ev.git.files_changed.length}): ${ev.git.files_changed.join(', ')}`, `# NUMBERS: spend $${numbers.cost.toFixed(2)} of $${numbers.budget.toFixed(2)} budget, waste $${numbers.waste.toFixed(2)}, human value $${numbers.value.toFixed(2)}`, ''].join('\n');
  const final = ev.final_messages.at(-1) ?? '';
  const tail = `\n# ASSISTANT'S FINAL MESSAGE (a claim)\n> ${final.slice(0, 600).replace(/\n/g, '\n> ')}\n# COMMANDS RUN\n${ev.command_runs.slice(-6).map((c) => `- ${c.command} → ${c.passed ? 'ok' : 'FAILED'}`).join('\n') || '(none)'}\n`;
  const budgetChars = tokenBudget * 4 - head.length - tail.length - 200;
  const diffSource = ev.git.diff_excerpt ? ev.git.diff_excerpt : ev.reconstruction.diff_text || '(empty diff)';
  const { text, truncated } = trimDiff(diffSource, prioritized, Math.max(1500, budgetChars));
  const label = ev.git.diff_excerpt ? '# DIFF' : ev.reconstruction.diff_text ? '# CHANGES RECONSTRUCTED FROM THE TRANSCRIPT (not verified against disk)' : '# DIFF';
  const prompt = `${head}${label}${truncated ? ' (trimmed to fit; hunks touching the criteria came first)' : ''}\n${text}\n${tail}`;
  return { prompt, tokens: approxTokens(prompt), truncated };
}

export interface MechanicalSummary {
  quality: { score: number; reason: string };
  verdict_reason: string;
  recommendations: string[];
}

/* Tier 0 stand-ins for the model's prose: a labelled proxy, never a fabricated reading of the code. */
export function mechanicalSummary(input: { ver: VerificationResult; completion_pct: number; counts: { met: number; partial: number; unmet: number; unverifiable: number }; waste: { total_usd: number; failed_loops: Array<{ command: string; repeats: number; usd: number }>; repeated_reads: Array<{ file: string; reads: number; usd: number }>; dead_weight: { usd: number; overhead_tokens: number }; compaction_churn: { usd: number; compactions: number } }; cost: number; budget: number; roi: number | null; unresolved: number }): MechanicalSummary {
  const { ver } = input;
  let score = 5;
  const why: string[] = ['mechanical proxy (no model read the code)'];
  if (ver.ran && ver.passed) {
    score += 2;
    why.push('independent tests passed');
  } else if (ver.ran) {
    score -= 3;
    why.push('independent tests failed');
  } else why.push('tests not run');
  if (input.waste.failed_loops.length) {
    score -= 1;
    why.push(`${input.waste.failed_loops.length} failed loop(s)`);
  }
  if (input.counts.unmet > 0) {
    score -= 1;
    why.push(`${input.counts.unmet} criterion(s) unmet`);
  }
  score = Math.max(0, Math.min(10, score));
  const recs: string[] = [];
  for (const l of input.waste.failed_loops.slice(0, 1)) recs.push(`\`${l.command}\` failed ${l.repeats} times in a row ($${l.usd.toFixed(2)}); after the second identical failure, read the output and change approach.`);
  for (const r of input.waste.repeated_reads.slice(0, 1)) recs.push(`${r.file} was read ${r.reads} times ($${r.usd.toFixed(2)}); keep notes instead of re-reading.`);
  if (input.waste.dead_weight.usd > 0.05) recs.push(`First-turn context carries ${input.waste.dead_weight.overhead_tokens.toLocaleString('en-US')} tokens above baseline ($${input.waste.dead_weight.usd.toFixed(2)} this session); prune unused skills and MCP servers.`);
  if (input.waste.compaction_churn.compactions > 0) recs.push(`${input.waste.compaction_churn.compactions} compaction(s) re-cached ${input.waste.compaction_churn.usd > 0 ? '$' + input.waste.compaction_churn.usd.toFixed(2) : 'context'}; write HANDOFF.md before /compact.`);
  if (input.cost > input.budget) recs.push(`Spend $${input.cost.toFixed(2)} exceeded the $${input.budget.toFixed(2)} budget; re-scope earlier next time.`);
  if (!ver.ran) recs.push('Allow test re-runs (tally config consent on) so test criteria stop being unverifiable.');
  while (recs.length < 3) recs.push(['Link the ticket before starting so criteria freeze at intake.', 'Run the full test suite once before pushing.', 'State what is left undone in the final message.'][recs.length]!);
  const verdict_reason = `Mechanical receipt: ${input.completion_pct}% of criteria resolved by checks (${input.counts.met} met, ${input.counts.partial} partial, ${input.counts.unmet} unmet, ${input.counts.unverifiable} unverifiable${input.unresolved ? `, ${input.unresolved} needed judgment but no model ran` : ''}). Independent tests ${ver.ran ? (ver.passed ? 'passed' : 'failed') : 'were not run'}. Spend $${input.cost.toFixed(2)} against a $${input.budget.toFixed(2)} budget with $${input.waste.total_usd.toFixed(2)} measured waste; ROI ${input.roi === null ? 'n/a' : input.roi + '×'}.`;
  return { quality: { score, reason: why.join('; ') }, verdict_reason, recommendations: recs.slice(0, 3) };
}
