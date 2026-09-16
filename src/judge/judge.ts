import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import type { LlmClient } from '../llm/client.js';
import { parseTranscriptFile, type Transcript } from '../transcript/parse.js';
import { computeWaste } from '../cost/waste.js';
import { attribute, markTouched } from '../cost/attribution.js';
import { readEvents, appendEvent, type TallyEvent } from '../store/events.js';
import { loadTask, type Task } from '../task/intake.js';
import { collectEvidence, type Evidence, type Exec } from './evidence.js';
import { runVerification, NO_CONSENT_REASON, type VerificationResult } from './verify.js';
import { redactDeep } from '../redact.js';
import { testRerunConsent } from '../config.js';

const TEST_CRITERION_RE = /\b(test|tests|tested|testing|spec|specs|coverage|passes|passing|green|ci)\b/i;

export function isTestCriterion(text: string): boolean {
  return TEST_CRITERION_RE.test(text);
}
import { JudgeSchema, type Judge, type Verdict } from './schema.js';
import { renderReport, renderSummary } from './report.js';
import { sessionDir, ensureDir, writeJson, historyFile, appendLine, repoKey, readJson } from '../paths.js';
import { tallySpendFile } from '../llm/client.js';

export const JUDGE_SYSTEM = `You are an independent, skeptical auditor of a coding session. You did NOT do the work and you must not take the working assistant's word for anything.
Evidence hierarchy, strongest first: (1) the INDEPENDENT test run that the auditor executed, (2) the git diff, (3) tool outputs recorded in the transcript, (4) the assistant's own messages, which are claims, not evidence.
For each acceptance criterion return exactly one status:
- "met": the diff or independent run shows it is done.
- "partial": clearly started with a visible gap.
- "unmet": no evidence of the work, or evidence it was skipped.
- "unverifiable": you cannot tell from the evidence given. Use this instead of guessing. A claim like "tests pass" with no independent run and no test output is unverifiable.
Cite concrete evidence: file paths, hunks, command output. Never invent files.
quality_score (0-10) judges the code you can see: correctness, tests, scope discipline, no debris (debug prints, TODOs, unrelated churn).
recommendations: exactly three short, specific, actionable habits for next time, ordered by expected dollars saved. Reference the waste figures when relevant.
verdict_reason: one paragraph weighing completion, quality, cost, waste and ROI numbers provided. Be direct.
Return only the JSON object.`;

export const JUDGE_SCHEMA = {
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
        },
        required: ['id', 'status', 'evidence', 'files'],
      },
    },
    quality_score: { type: 'number' },
    quality_reason: { type: 'string' },
    verdict_reason: { type: 'string' },
    recommendations: { type: 'array', items: { type: 'string' } },
  },
  required: ['criteria', 'quality_score', 'quality_reason', 'verdict_reason', 'recommendations'],
} as const;

interface JudgeOut {
  criteria: Array<{ id: string; status: 'met' | 'partial' | 'unmet' | 'unverifiable'; evidence: string; files: string[] }>;
  quality_score: number;
  quality_reason: string;
  verdict_reason: string;
  recommendations: string[];
}

export function judgeFile(session: string): string {
  return path.join(sessionDir(session), 'judge.json');
}

export function loadJudge(session: string): Judge | null {
  const raw = readJson<unknown>(judgeFile(session), null);
  if (!raw) return null;
  const p = JudgeSchema.safeParse(raw);
  return p.success ? p.data : null;
}

export function computeVerdict(input: { completion_pct: number; roi: number | null; quality: number; testsFailed: boolean }): Verdict {
  const { completion_pct, roi, quality, testsFailed } = input;
  const roiOk = roi === null ? true : roi >= 2;
  const roiBad = roi !== null && roi < 1;
  if (completion_pct < 40 || roiBad || quality < 4) return 'not worth it';
  if (completion_pct >= 70 && roiOk && quality >= 6 && !testsFailed) return 'worth it';
  return 'borderline';
}

function bucket(x: { usage: { input: number; output: number; cache_write: number; cache_read: number }; cost: number; messages: number }): { usd: number; messages: number; tokens: number } {
  return { usd: round(x.cost), messages: x.messages, tokens: x.usage.input + x.usage.output + x.usage.cache_write + x.usage.cache_read };
}

function round(n: number, d = 4): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

export function tallyOwnSpend(session: string): number {
  const f = tallySpendFile();
  if (!fs.existsSync(f)) return 0;
  let sum = 0;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line) as { session?: string; cost_usd?: number };
      if (j.session === session) sum += j.cost_usd ?? 0;
    } catch {
      /* skip */
    }
  }
  return sum;
}

function buildPrompt(task: Task, t: Transcript, ev: Evidence, ver: VerificationResult, numbers: { cost: number; waste: number; value: number; budget: number }): string {
  const parts: string[] = [];
  parts.push(`# TASK\nTitle: ${task.title}\nSource: ${task.source.kind} ${task.source.url ?? ''}\nSpec quality at intake: ${task.spec_quality.score}/10\n\n## Frozen acceptance criteria`);
  for (const c of task.criteria) parts.push(`- ${c.id}: ${c.text} [${c.source}]`);
  parts.push(`\n# INDEPENDENT VERIFICATION (run by the auditor, not the assistant)`);
  if (ver.ran) parts.push(`Command: ${ver.command}\nResult: ${ver.passed ? 'PASSED' : ver.timed_out ? 'TIMED OUT' : `FAILED (exit ${ver.exit_code})`} in ${ver.duration_ms} ms\nOutput tail:\n${ver.output_tail}`);
  else parts.push(`Not run: ${ver.reason}.${ver.reason === NO_CONSENT_REASON ? ' The user has not allowed the auditor to run tests in this repo. Any criterion about tests passing or coverage can only be "unverifiable" unless the diff itself proves it; transcript claims of passing tests do not count.' : ''}`);
  parts.push(`\n# GIT EVIDENCE\nBranch: ${ev.git.branch ?? '?'}  Base: ${ev.git.base_head?.slice(0, 8) ?? 'unknown'}  ${ev.git.error ? 'NOTE: ' + ev.git.error : ''}\nFiles changed (${ev.git.files_changed.length}): ${ev.git.files_changed.join(', ') || '(none)'}\n+${ev.git.insertions} -${ev.git.deletions}\n\n## Diff\n${ev.git.diff_excerpt || '(empty diff)'}`);
  parts.push(`\n# COMMANDS THE ASSISTANT RAN (from transcript; outputs are tool results, not claims)`);
  if (ev.command_runs.length === 0) parts.push('(no test or lint commands run)');
  for (const r of ev.command_runs) parts.push(`- [${r.kind}] ${r.command} -> ${r.passed ? 'exit 0' : 'FAILED'}\n  ${r.output_tail.split('\n').slice(-6).join('\n  ')}`);
  parts.push(`\n# SHIP EVENTS\n${ev.ship_events.map((s) => `- ${s.kind}: ${s.command} ${s.url ?? ''}`).join('\n') || '(none)'}`);
  parts.push(`\n# USER PROMPTS\n${ev.prompts.map((p, i) => `${i + 1}. ${p}`).join('\n')}`);
  parts.push(`\n# ASSISTANT'S FINAL MESSAGES (claims, verify against evidence)\n${ev.final_messages.map((m) => `> ${m.replace(/\n/g, '\n> ')}`).join('\n\n') || '(none)'}`);
  parts.push(`\n# NUMBERS (already computed)\nAPI-equivalent spend: $${numbers.cost.toFixed(2)} (budget $${numbers.budget.toFixed(2)})\nMeasured waste: $${numbers.waste.toFixed(2)}\nHuman-equivalent value at full completion: $${numbers.value.toFixed(2)}\nTool calls: ${ev.tool_call_count}; compactions: ${t.compactions.length}; subagents: ${Object.keys(t.byAgent).filter((a) => a !== 'main').length}`);
  return parts.join('\n');
}

export async function judgeSession(opts: {
  session: string;
  cwd: string;
  transcriptPath: string;
  cfg: Config;
  llm: LlmClient;
  reason: Judge['reason'];
  exec?: Exec;
  events?: TallyEvent[];
  verification?: VerificationResult;
  task?: Task | null;
  consent?: boolean;
}): Promise<Judge> {
  const events = opts.events ?? readEvents(opts.session);
  const t = parseTranscriptFile(opts.transcriptPath);
  if (t.internal) throw new Error('refusing to judge one of Tally\'s own internal runs');
  let task = opts.task === undefined ? loadTask(opts.session) : opts.task;
  const linked = !!task;
  if (!task) task = implicitTask(opts.session, opts.cwd, t, opts.cfg);
  const ev = collectEvidence({ cwd: opts.cwd, transcript: t, events, exec: opts.exec });
  const consent = opts.consent ?? testRerunConsent(opts.cfg, opts.cwd);
  const ver = opts.verification ?? (await runVerification(opts.cwd, { timeoutMs: opts.cfg.judge.test_timeout_ms, enabled: opts.cfg.judge.run_tests, consent }));
  const waste = computeWaste(t, { baselineTokens: opts.cfg.baseline_context_tokens });
  const humanValue = task.estimate.hours * task.hourly_rate;

  const prompt = buildPrompt(task, t, ev, ver, { cost: t.cost, waste: waste.total_usd, value: humanValue, budget: task.budget_usd });
  const r = await opts.llm.complete<JudgeOut>({ kind: 'judge', model: opts.cfg.models.judge, system: JUDGE_SYSTEM, prompt, schema: JUDGE_SCHEMA as unknown as Record<string, unknown>, timeoutMs: 300000 });
  /* model output is text that may echo secrets from the diff; it goes through the same redactor as hook events */
  const out = redactDeep(r.data);

  const noConsent = !ver.ran && ver.reason === NO_CONSENT_REASON;
  const byId = new Map((out.criteria ?? []).map((c) => [c.id, c]));
  const criteria = task.criteria.map((c) => {
    const j = byId.get(c.id);
    let status: 'met' | 'partial' | 'unmet' | 'unverifiable' = j && ['met', 'partial', 'unmet', 'unverifiable'].includes(j.status) ? j.status : 'unverifiable';
    let evidence = j?.evidence ?? 'No assessment returned by the judge model.';
    if (noConsent && isTestCriterion(c.text) && status !== 'unmet') {
      status = 'unverifiable';
      evidence = `unverifiable (${NO_CONSENT_REASON}). ${evidence}`;
    }
    return { id: c.id, text: c.text, status, evidence, files: (j?.files ?? []).map(String) };
  });
  const counts = { met: 0, partial: 0, unmet: 0, unverifiable: 0 };
  for (const c of criteria) counts[c.status] += 1;
  const completion_pct = criteria.length ? round(((counts.met + 0.5 * counts.partial) / criteria.length) * 100, 1) : 0;
  const quality = Math.max(0, Math.min(10, Number(out.quality_score ?? 0)));
  const credited = round(humanValue * (completion_pct / 100), 2);
  const roi = t.cost > 0 ? round(credited / t.cost, 2) : null;
  const testsFailed = ver.ran && ver.passed === false;
  const verdict = computeVerdict({ completion_pct, roi, quality, testsFailed });

  const rows = markTouched(
    attribute(t),
    t,
    criteria.filter((c) => c.status === 'met').flatMap((c) => c.files),
  );
  const tallyOwn = tallyOwnSpend(opts.session);

  const judge: Judge = {
    version: 1,
    session: opts.session,
    cwd: opts.cwd,
    judged_at: new Date().toISOString(),
    reason: opts.reason,
    task: { title: task.title, source: { kind: task.source.kind, url: task.source.url, ref: task.source.ref }, spec_quality: task.spec_quality.score, estimate_hours: task.estimate.hours, budget_usd: task.budget_usd, linked },
    criteria,
    completion_pct,
    counts,
    quality: { score: quality, reason: String(out.quality_reason ?? '') },
    verification: ver,
    evidence: {
      files_changed: ev.git.files_changed,
      edited_files: ev.edited_files,
      diff_stat: ev.git.diff_stat,
      insertions: ev.git.insertions,
      deletions: ev.git.deletions,
      base_head: ev.git.base_head,
      current_head: ev.git.current_head,
      branch: ev.git.branch,
      git_error: ev.git.error,
      command_runs: ev.command_runs.map((c) => ({ command: c.command, kind: c.kind, passed: c.passed, ts: c.ts })),
      ship_events: ev.ship_events,
      final_message: ev.final_messages.at(-1) ?? '',
      tool_calls: ev.tool_call_count,
    },
    cost: {
      label: 'API-equivalent',
      total_usd: round(t.cost),
      usage: t.usage,
      by_phase: Object.fromEntries(Object.entries(t.byPhase).map(([k, v]) => [k, bucket(v)])),
      by_subagent: Object.fromEntries(Object.entries(t.byAgent).map(([k, v]) => [k, bucket(v)])),
      by_model: Object.fromEntries(Object.entries(t.byModel).map(([k, v]) => [k, bucket(v)])),
      per_completed_criterion_usd: counts.met > 0 ? round(t.cost / counts.met, 2) : null,
      budget_usd: task.budget_usd,
      budget_used_pct: task.budget_usd > 0 ? round((t.cost / task.budget_usd) * 100, 1) : 0,
      tally_own_usd: round(tallyOwn + r.cost_usd),
      tally_share_pct: t.cost > 0 ? round(((tallyOwn + r.cost_usd) / t.cost) * 100, 1) : 0,
      confidence: t.cost_confidence,
      format: t.format,
      models: t.models,
    },
    waste: {
      total_usd: round(waste.total_usd),
      failed_loops: waste.failed_loops.map((l) => ({ ...l, usd: round(l.usd) })),
      repeated_reads: waste.repeated_reads.map((l) => ({ ...l, usd: round(l.usd) })),
      dead_weight: { ...waste.dead_weight, usd: round(waste.dead_weight.usd) },
      compaction_churn: { ...waste.compaction_churn, usd: round(waste.compaction_churn.usd) },
    },
    value: { estimate_hours: task.estimate.hours, hourly_rate: task.hourly_rate, human_value_usd: round(humanValue, 2), credited_value_usd: credited, roi_multiple: roi },
    attribution: { label: 'correlational', note: 'Whether a skill or MCP call touched a met criterion is a correlation, not a cause. Run `tally experiment start <skill|mcp> <name> --tasks N` for a controlled answer.', rows },
    verdict: { verdict, reason: String(out.verdict_reason ?? '') },
    recommendations: (out.recommendations ?? []).map(String).filter(Boolean).slice(0, 3),
    judge_model: r.model,
  };
  const validated = JudgeSchema.parse(judge);
  persistJudge(validated, task);
  return validated;
}

export function persistJudge(judge: Judge, task: Task | null): void {
  const dir = sessionDir(judge.session);
  ensureDir(dir);
  const file = judgeFile(judge.session);
  if (fs.existsSync(file)) fs.copyFileSync(file, path.join(dir, 'judge.prev.json'));
  writeJson(file, judge);
  fs.writeFileSync(path.join(dir, 'report.md'), renderReport(judge));
  appendEvent({ ts: new Date().toISOString(), type: 'judge', session: judge.session, cwd: judge.cwd, data: { verdict: judge.verdict.verdict, completion_pct: judge.completion_pct, cost_usd: judge.cost.total_usd, reason: judge.reason } });
  const entry = {
    ts: judge.judged_at,
    session: judge.session,
    repo: judge.cwd ? repoKey(judge.cwd) : undefined,
    task_title: judge.task.title,
    source: judge.task.source,
    verdict: judge.verdict.verdict,
    completion_pct: judge.completion_pct,
    quality: judge.quality.score,
    cost_usd: judge.cost.total_usd,
    waste_usd: judge.waste.total_usd,
    roi: judge.value.roi_multiple,
    per_criterion_usd: judge.cost.per_completed_criterion_usd,
    recommendations: judge.recommendations,
    skills: judge.attribution.rows.filter((r) => r.kind === 'skill').map((r) => r.name),
    mcp: judge.attribution.rows.filter((r) => r.kind === 'mcp').map((r) => r.name),
    final_status: judge.followup?.final_status,
    final_verdict: judge.followup?.final_verdict,
    linked: judge.task.linked,
    tally_own_usd: judge.cost.tally_own_usd,
    tally_share_pct: judge.cost.tally_share_pct,
    cost_confidence: judge.cost.confidence,
    internal: false,
    criteria_count: judge.criteria.length,
    met: judge.counts.met,
    spec_quality: task?.spec_quality.score,
  };
  appendLine(historyFile(), JSON.stringify(entry));
}

export function implicitTask(session: string, cwd: string, t: Transcript, cfg: Config): Task {
  const first = t.prompts[0]?.text ?? 'Untitled session';
  const title = first.split('\n')[0]!.slice(0, 90);
  return {
    session,
    cwd,
    created_at: new Date().toISOString(),
    frozen: true,
    source: { kind: 'text', ref: first },
    title,
    body_excerpt: first.slice(0, 1500),
    labels: [],
    criteria: [{ id: 'c1', text: `Deliver what the first prompt asked: ${title}`, source: 'inferred' }],
    spec_quality: { score: 0, missing: ['no linked task; criteria inferred from the first prompt'], questions: [] },
    needs_clarification: true,
    estimate: { hours: 1, basis: 'default' },
    budget_usd: Math.max(2, 1 * cfg.hourly_rate * 0.25),
    hourly_rate: cfg.hourly_rate,
    tally_cost_usd: 0,
    model: 'none',
  };
}

export { renderReport, renderSummary };
