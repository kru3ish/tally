import type { Judge } from './schema.js';
import { renderReview, type Review } from './review.js';
import { fmtUsd } from '../cost/pricing.js';

const STATUS_ICON: Record<string, string> = { met: '✔', partial: '◐', unmet: '✘', unverifiable: '?' };

export function renderReport(j: Judge): string {
  const L: string[] = [];
  L.push(`# Tally receipt: ${j.task.title}`);
  L.push('');
  L.push(`Session \`${j.session}\` · judged ${j.judged_at} on ${j.reason} · judge model ${j.judge_model}`);
  if (j.task.source.url) L.push(`Source: ${j.task.source.url}`);
  if (!j.task.linked) L.push('> No task was linked. Criteria were inferred from the first prompt; link a ticket next time with `tally task <url>`.');
  L.push('');
  L.push(`## Verdict: **${j.verdict.verdict.toUpperCase()}**${j.followup ? ` → after follow-up: **${j.followup.final_verdict.toUpperCase()}** (${j.followup.final_status})` : ''}`);
  L.push('');
  L.push(j.verdict.reason);
  if (j.followup) {
    L.push('');
    L.push(`### Follow-up (${j.followup.checked_at})`);
    for (const n of j.followup.notes) L.push(`- ${n}`);
  }
  L.push('');
  if (j.safety?.flags.length) {
    L.push(`## Safety — ${j.safety.flags.length} flagged event(s)`);
    for (const f of j.safety.flags) L.push(`- ${f.ts.slice(11, 19)} ${f.kind}: ${esc(f.detail)}`);
    L.push('');
  }
  L.push(`## Acceptance criteria — ${j.completion_pct}% complete${j.completion_basis && j.completion_basis.verifiable < j.completion_basis.total ? ` of ${j.completion_basis.verifiable} verifiable` : ''} (${j.counts.met} met, ${j.counts.partial} partial, ${j.counts.unmet} unmet, ${j.counts.unverifiable} unverifiable)`);
  L.push('');
  L.push('| # | Status | Criterion | Evidence |');
  L.push('|---|---|---|---|');
  for (const c of j.criteria) L.push(`| ${c.id} | ${STATUS_ICON[c.override?.status ?? c.status]} ${c.override ? `${c.override.status} (disputed, was ${c.override.original})` : c.status} | ${esc(c.text)} | ${esc(c.evidence)}${c.override ? ` · dispute by ${esc(c.override.by)}: ${esc(c.override.reason)}` : ''}${c.files.length ? ` (${c.files.join(', ')})` : ''} _${c.resolved_by}${c.confidence !== undefined && c.resolved_by !== 'tier0' ? `, conf ${c.confidence.toFixed(2)}` : ''}_ |`);
  L.push('');
  L.push(`## How it was judged`);
  L.push('');
  L.push(`Tiers run: ${j.tiers.ran.map(tierLabel).join(' → ')}. ${j.tiers.reason}. ${j.tiers.mechanical} criteria mechanical (checks), ${j.tiers.judgment} judgment.${j.tiers.calls.length ? ' Model calls: ' + j.tiers.calls.map((c) => `${c.tier} ${c.model} on ${c.criteria.join(', ')} (${c.prompt_tokens.toLocaleString('en-US')} prompt tokens, ${fmtUsd(c.cost_usd)})`).join('; ') + '.' : ' No model call.'}${j.tiers.escalations?.length ? ' Escalated: ' + j.tiers.escalations.map((e) => `${e.id} (${e.reason})`).join(', ') + '.' : ''}`);
  L.push('');
  L.push(`## Quality: ${j.quality.score}/10`);
  L.push('');
  L.push(j.quality.reason);
  L.push('');
  L.push('## Independent verification');
  L.push('');
  if (j.verification.ran) {
    L.push(`Ran \`${j.verification.command}\` (${j.verification.basis}): **${j.verification.passed ? 'PASSED' : j.verification.timed_out ? 'TIMED OUT' : 'FAILED'}** in ${j.verification.duration_ms} ms.`);
    if (!j.verification.passed && j.verification.output_tail) {
      L.push('');
      L.push('```');
      L.push(j.verification.output_tail.split('\n').slice(-25).join('\n'));
      L.push('```');
    }
  } else {
    L.push(`Not run: ${j.verification.reason}.`);
  }
  L.push('');
  L.push(`## Cost (${j.cost.label}) — ${fmtUsd(j.cost.total_usd)} of ${fmtUsd(j.cost.budget_usd)} budget (${j.cost.budget_used_pct}%)`);
  L.push('');
  L.push(`Per completed criterion: ${j.cost.per_completed_criterion_usd === null ? 'n/a (none met)' : fmtUsd(j.cost.per_completed_criterion_usd)} · Tally's own spend: ${fmtUsd(j.cost.tally_own_usd)} (${j.cost.tally_share_pct}% of session spend, counted separately) · models: ${j.cost.models.join(', ')}`);
  if (j.cost.confidence === 'partial') L.push(`\n> **Cost is partial.** Transcript format ${j.cost.format.version ?? 'unknown'}${j.cost.format.known ? '' : ' is not a verified layout'}; ${j.cost.format.unparseable_lines} of ${j.cost.format.total_lines} lines could not be parsed${j.cost.format.unknown_types.length ? `; unknown line types: ${j.cost.format.unknown_types.join(', ')}` : ''}. Run \`tally doctor\`.`);
  if (j.cost.otel?.available) L.push(`\nOTel cross-check: ${fmtUsd(j.cost.otel.total_usd ?? 0)} reported by Claude Code telemetry (${(j.cost.otel.delta_usd ?? 0) >= 0 ? '+' : ''}${fmtUsd(j.cost.otel.delta_usd ?? 0)} vs transcript).`);
  L.push('');
  L.push('| Phase | Spend | Calls |');
  L.push('|---|---|---|');
  for (const [k, v] of Object.entries(j.cost.by_phase)) L.push(`| ${k} | ${fmtUsd(v.usd)} | ${v.messages} |`);
  L.push('');
  L.push('| Agent | Spend | Calls |');
  L.push('|---|---|---|');
  for (const [k, v] of Object.entries(j.cost.by_subagent)) L.push(`| ${k} | ${fmtUsd(v.usd)} | ${v.messages} |`);
  L.push('');
  if (j.review) {
    L.push('## Maintainer review');
    for (const line of renderReview(j.review as Review)) L.push(line.startsWith('  ') ? `- ${line.trim()}` : line);
    L.push('');
  }
  L.push(`## Waste — ${fmtUsd(j.waste.total_usd)}`);
  L.push('');
  L.push(`- Failed loops: ${fmtUsd(j.waste.failed_loops.reduce((s, x) => s + x.usd, 0))}${j.waste.failed_loops.length ? ' — ' + j.waste.failed_loops.map((l) => `\`${l.command}\` ×${l.repeats}`).join(', ') : ''}`);
  L.push(`- Repeated reads: ${fmtUsd(j.waste.repeated_reads.reduce((s, x) => s + x.usd, 0))}${j.waste.repeated_reads.length ? ' — ' + j.waste.repeated_reads.map((r) => `${r.file} ×${r.reads}`).join(', ') : ''}`);
  L.push(`- Setup cost (your environment, not this session's waste): ${fmtUsd(j.waste.dead_weight.usd)} — first turn loaded ${j.waste.dead_weight.first_turn_tokens.toLocaleString('en-US')} tokens, ${j.waste.dead_weight.overhead_tokens.toLocaleString('en-US')} above the ${j.waste.dead_weight.baseline_tokens.toLocaleString('en-US')} baseline; global CLAUDE.md, plugins and skills are paid for on every turn of every session`);
  L.push(`- Compaction churn: ${fmtUsd(j.waste.compaction_churn.usd)} — ${j.waste.compaction_churn.compactions} compaction(s), ${j.waste.compaction_churn.recache_tokens.toLocaleString('en-US')} tokens re-cached`);
  L.push('');
  L.push('## Value');
  L.push('');
  L.push(`${j.value.estimate_hours}h human estimate × $${j.value.hourly_rate}/h = ${fmtUsd(j.value.human_value_usd)}; credited at ${j.completion_pct}% completion = ${fmtUsd(j.value.credited_value_usd)}; spend ${fmtUsd(j.cost.total_usd)} → **ROI ${j.value.roi_multiple === null ? 'n/a' : j.value.roi_multiple + '×'}**`);
  L.push('');
  L.push(`## Skill and MCP attribution (${j.attribution.label})`);
  L.push('');
  L.push(j.attribution.note);
  L.push('');
  if (j.attribution.rows.length) {
    L.push('| Kind | Name | Invocations | Errors | Tokens | Spend | Touched a met criterion |');
    L.push('|---|---|---|---|---|---|---|');
    for (const r of j.attribution.rows) L.push(`| ${r.kind} | ${r.name} | ${r.invocations} | ${r.errors} | ${r.tokens.toLocaleString('en-US')} | ${fmtUsd(r.usd)} | ${r.touched_met_criteria === null ? '–' : r.touched_met_criteria ? 'yes' : 'no'} |`);
  } else {
    L.push('_No skills or MCP tools were invoked._');
  }
  L.push('');
  L.push('## Recommendations');
  L.push('');
  for (const r of j.recommendations) L.push(`1. ${r}`);
  L.push('');
  L.push(`## Evidence`);
  L.push('');
  L.push(`Branch ${j.evidence.branch ?? '?'}, base ${j.evidence.base_head?.slice(0, 8) ?? '?'} → ${j.evidence.current_head?.slice(0, 8) ?? '?'}; ${j.evidence.files_changed.length} files, +${j.evidence.insertions} −${j.evidence.deletions}; ${j.evidence.tool_calls} tool calls.${j.evidence.git_error ? ` (${j.evidence.git_error})` : ''}`);
  if (j.evidence.files_changed.length) L.push(`Files: ${j.evidence.files_changed.join(', ')}`);
  if (j.evidence.ship_events.length) L.push(`Shipped: ${j.evidence.ship_events.map((s) => `${s.kind}${s.url ? ' ' + s.url : ''}`).join('; ')}`);
  L.push('');
  return L.join('\n') + '\n';
}

function tierLabel(t: 'tier0' | 'tier1' | 'tier2'): string {
  return t === 'tier0' ? 'tier 0 (mechanical)' : t === 'tier1' ? 'tier 1 (small model)' : 'tier 2 (strong model)';
}

function esc(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function renderSummary(j: Judge, color = true): string {
  const c = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const verdictColor = j.verdict.verdict === 'worth it' ? '32' : j.verdict.verdict === 'borderline' ? '33' : j.verdict.verdict === 'insufficient evidence' ? '90' : '31';
  const L: string[] = [];
  L.push(c('1', `Tally receipt · ${j.task.title}`));
  L.push(`${c(verdictColor, c('1', j.verdict.verdict.toUpperCase()))}${j.followup ? `  → after follow-up: ${c('1', j.followup.final_verdict.toUpperCase())} (${j.followup.final_status})` : ''}  ·  ${j.completion_pct}% complete${j.completion_basis && j.completion_basis.verifiable < j.completion_basis.total ? ` (${j.counts.unverifiable} unverifiable)` : ''}  ·  quality ${j.quality.score}/10  ·  ROI ${j.value.roi_multiple === null ? 'n/a' : j.value.roi_multiple + '×'}`);
  for (const cr of j.criteria) {
    const col = cr.status === 'met' ? '32' : cr.status === 'partial' ? '33' : cr.status === 'unmet' ? '31' : '90';
    L.push(`  ${c(col, STATUS_ICON[cr.override?.status ?? cr.status]!)} ${cr.id} ${cr.text} ${c('90', `[${cr.resolved_by === 'tier0' ? 'check' : cr.resolved_by === 'rule' ? 'rule' : cr.resolved_by}${cr.confidence !== undefined && cr.resolved_by !== 'tier0' ? ` ${cr.confidence.toFixed(2)}` : ''}]`)}${cr.override ? c('36', `  disputed: ${cr.override.original} → ${cr.override.status} by ${cr.override.by} (${cr.override.reason})`) : ''}`);
  }
  L.push(`Judged by: ${j.tiers.ran.map((t) => t.replace('tier', 'tier ')).join(' → ')} · ${j.tiers.reason}${j.tiers.calls.length ? ` · model spend ${fmtUsd(j.tiers.llm_cost_usd)}` : ' · $0 in model calls'}`);
  L.push(`Verification: ${j.verification.ran ? `${j.verification.command} → ${j.verification.passed ? c('32', 'passed') : c('31', j.verification.timed_out ? 'timed out' : 'FAILED')}` : c('90', `not run (${j.verification.reason})`)}`);
  if (j.review) for (const line of renderReview(j.review as Review)) L.push(line);
  L.push(`Cost (API-equivalent${j.cost.confidence === 'partial' ? ', PARTIAL: transcript not fully parsed' : ''}): ${fmtUsd(j.cost.total_usd)} / budget ${fmtUsd(j.cost.budget_usd)} (${j.cost.budget_used_pct}%) · per met criterion ${j.cost.per_completed_criterion_usd === null ? 'n/a' : fmtUsd(j.cost.per_completed_criterion_usd)} · waste ${fmtUsd(j.waste.total_usd)}`);
  L.push(`  Tally's own spend: ${fmtUsd(j.cost.tally_own_usd)} (${j.cost.tally_share_pct}% of session spend, separate)${j.cost.otel?.available ? ` · OTel cross-check ${fmtUsd(j.cost.otel.total_usd ?? 0)}` : ''}`);
  const phases = Object.entries(j.cost.by_phase)
    .filter(([, v]) => v.usd > 0)
    .map(([k, v]) => `${k} ${fmtUsd(v.usd)}`)
    .join(', ');
  const agents = Object.entries(j.cost.by_subagent)
    .filter(([k]) => k !== 'main')
    .map(([k, v]) => `${k} ${fmtUsd(v.usd)}`)
    .join(', ');
  L.push(`  by phase: ${phases}${agents ? `  · subagents: ${agents}` : ''}`);
  L.push(`Value: ${j.value.estimate_hours}h × $${j.value.hourly_rate} = ${fmtUsd(j.value.human_value_usd)}, credited ${fmtUsd(j.value.credited_value_usd)}`);
  L.push(`Why: ${j.verdict.reason}`);
  if (j.recommendations.length) {
    L.push('Next time:');
    for (const r of j.recommendations) L.push(`  • ${r}`);
  }
  return L.join('\n');
}
