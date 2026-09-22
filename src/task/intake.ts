import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { LlmClient } from '../llm/client.js';
import crypto from 'node:crypto';
import { sessionDir, ensureDir, writeJson, readJson, tallyHome } from '../paths.js';
import { fetchTask, type FetchDeps, type FetchedTask, type TaskSource } from './fetchers.js';
import { appendEvent } from '../store/events.js';
import { CheckSpecSchema, CHECK_JSON_SCHEMA, parseCheck } from '../judge/checks.js';
import { loadPolicy } from '../policy.js';

export const CriterionSchema = z.object({
  id: z.string(),
  text: z.string(),
  source: z.enum(['explicit', 'inferred', 'policy']),
  kind: z.enum(['mechanical', 'judgment']).default('judgment'),
  check: CheckSpecSchema.optional(),
});

export const TaskSchema = z.object({
  session: z.string(),
  cwd: z.string().optional(),
  created_at: z.string(),
  frozen: z.literal(true),
  source: z.object({
    kind: z.enum(['github', 'jira', 'linear', 'file', 'text']),
    ref: z.string(),
    url: z.string().optional(),
    owner: z.string().optional(),
    repo: z.string().optional(),
    number: z.number().optional(),
    key: z.string().optional(),
    is_pr: z.boolean().optional(),
  }),
  title: z.string(),
  body_excerpt: z.string(),
  labels: z.array(z.string()),
  fetch_error: z.string().optional(),
  criteria: z.array(CriterionSchema),
  spec_quality: z.object({ score: z.number().min(0).max(10), missing: z.array(z.string()), questions: z.array(z.string()) }),
  needs_clarification: z.boolean(),
  estimate: z.object({ hours: z.number().nonnegative(), basis: z.enum(['story_points', 'llm', 'default']), story_points: z.number().optional() }),
  budget_usd: z.number().nonnegative(),
  hourly_rate: z.number(),
  tally_cost_usd: z.number(),
  model: z.string(),
  cache_key: z.string().optional(),
  cached: z.boolean().optional(),
  historical: z.object({ ticket_as_of: z.enum(['current', 'session_start']), note: z.string() }).optional(),
  /* no tracker link: criteria were inferred from the prompts, branch name and commits; unconfirmed until the user says so */
  inferred: z.boolean().optional(),
  confirmed: z.boolean().optional(),
  context: z.object({ branch: z.string().optional(), commits: z.array(z.string()).optional() }).optional(),
});

export type Task = z.infer<typeof TaskSchema>;

export const HOURS_PER_STORY_POINT = 4;
export const BUDGET_FRACTION = 0.25;
export const BUDGET_FLOOR_USD = 2;

export const INTAKE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    criteria: {
      type: 'array',
      items: { type: 'object', properties: { text: { type: 'string' }, source: { type: 'string', enum: ['explicit', 'inferred'] }, check: CHECK_JSON_SCHEMA }, required: ['text', 'source', 'check'] },
    },
    spec_quality: {
      type: 'object',
      properties: { score: { type: 'number' }, missing: { type: 'array', items: { type: 'string' } }, questions: { type: 'array', items: { type: 'string' } } },
      required: ['score', 'missing', 'questions'],
    },
    estimate_hours: { type: 'number' },
    rationale: { type: 'string' },
  },
  required: ['title', 'criteria', 'spec_quality', 'estimate_hours', 'rationale'],
} as const;

export const INTAKE_SYSTEM = `You turn a software task description into a frozen checklist of acceptance criteria for a later, skeptical audit.
Rules:
- Each criterion must be a single verifiable statement about observable behaviour, code, tests, or docs. No vague "works well".
- Mark a criterion "explicit" when the ticket states it (including checkbox lists), "inferred" when a competent engineer would assume it (tests for new behaviour, no regressions). Keep inferred criteria to at most 3 and the whole list to at most 8; merge minor points rather than listing every sentence.
- spec_quality.score is 0-10: 10 = every criterion is testable and scoped; 5 = usable but missing key details; below 5 = the engineer should ask questions before starting. List what is missing and the exact questions to ask.
- estimate_hours is the human-hours a competent engineer would need without AI assistance, including tests. Be realistic, not optimistic.
- For each criterion give a "check": a mechanical test that decides it with no judgment, or kind "none" when only a reader can decide.
  Kinds: "tests_pass" (the project's test suite passes), "file_exists" {path}, "file_changed" {path} (the file appears in the diff), "file_contains" {path, pattern (regex)}, "diff_contains" {pattern (regex)}, "command" {command, expect_exit} (only the repo's own npm/make/test scripts), "pr" {state: pushed|opened|merged}.
  Prefer a check whenever the ticket names a file, a command, a test, or a PR outcome. Use "none" for behaviour that needs reading the code (correctness, edge cases, "works", "unchanged").
Return only the JSON object.`;

/* A check whose path is not a plausible repo-relative path (spaces, absolute, empty) decides nothing; it becomes a judgment criterion. */
export function sanitiseCheck(check: ReturnType<typeof parseCheck>): ReturnType<typeof parseCheck> {
  if (!check) return null;
  const p = 'path' in check ? check.path : undefined;
  if (p !== undefined && p !== '.' && p !== '*' && (/\s/.test(p) || /^([A-Za-z]:)?[\\/]/.test(p) || p.length > 200)) return null;
  return check;
}

interface IntakeOut {
  title: string;
  criteria: Array<{ text: string; source: 'explicit' | 'inferred'; check?: unknown }>;
  spec_quality: { score: number; missing: string[]; questions: string[] };
  estimate_hours: number;
  rationale: string;
}

export function taskFile(session: string): string {
  return path.join(sessionDir(session), 'task.json');
}

export function intakeCacheKey(fetched: FetchedTask, model: string): string {
  const material = JSON.stringify({ kind: fetched.source.kind, ref: fetched.source.url ?? fetched.source.ref, title: fetched.title, body: fetched.body, labels: fetched.labels, sp: fetched.story_points ?? null, model, v: 2 });
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
}

export function intakeCacheFile(key: string): string {
  return path.join(tallyHome(), 'cache', 'intake', `${key}.json`);
}

export function loadTask(session: string): Task | null {
  const raw = readJson<unknown>(taskFile(session), null);
  if (!raw) return null;
  const p = TaskSchema.safeParse(raw);
  return p.success ? p.data : null;
}

export function computeEstimate(fetched: FetchedTask, llmHours: number): Task['estimate'] {
  if (typeof fetched.story_points === 'number' && fetched.story_points > 0) {
    return { hours: fetched.story_points * HOURS_PER_STORY_POINT, basis: 'story_points', story_points: fetched.story_points };
  }
  if (llmHours > 0) return { hours: Math.round(llmHours * 10) / 10, basis: 'llm' };
  return { hours: 2, basis: 'default' };
}

export function computeBudget(hours: number, hourlyRate: number): number {
  return Math.max(BUDGET_FLOOR_USD, Math.round(hours * hourlyRate * BUDGET_FRACTION * 100) / 100);
}

export async function intake(opts: {
  session: string;
  cwd: string;
  ref?: string;
  text?: string;
  cfg: Config;
  llm: LlmClient;
  deps?: FetchDeps;
  force?: boolean;
  noCache?: boolean;
  /* backfill: ticket text as it read at session start, and a note stored on the task */
  override?: { title: string; body: string };
  historical?: { ticket_as_of: 'current' | 'session_start'; note: string };
  /* branch name and commit subjects, used when the task is inferred from prompts */
  context?: { branch?: string; commits?: string[] };
}): Promise<{ task: Task; created: boolean }> {
  const existing = loadTask(opts.session);
  if (existing && !opts.force) return { task: existing, created: false };

  const ref = opts.ref ?? opts.text ?? '';
  const fetched = await fetchTask(ref, { cwd: opts.cwd, cfg: opts.cfg, deps: opts.deps, promptText: opts.text });
  if (opts.override) {
    fetched.title = opts.override.title;
    fetched.body = opts.override.body;
  }
  const bodyForLlm = fetched.body.slice(0, 12000);
  const inferred = fetched.source.kind === 'text';
  const ctxText = inferred && opts.context ? `\n${opts.context.branch ? `BRANCH: ${opts.context.branch}\n` : ''}${opts.context.commits?.length ? `COMMITS MADE DURING THE SESSION (the strongest evidence of what the engineer set out to do; weight them above the prompt wording):\n${opts.context.commits.slice(0, 20).map((c) => '- ' + c).join('\n')}\n` : ''}` : '';
  const prompt = `TITLE: ${fetched.title}\nSOURCE: ${fetched.source.kind}${fetched.source.url ? ' ' + fetched.source.url : ''}${inferred ? ' (no ticket: infer the task from the developer\'s own words, branch and commits; keep criteria to what they evidently set out to do)' : ''}\nLABELS: ${fetched.labels.join(', ') || '(none)'}\n${fetched.story_points ? `STORY POINTS: ${fetched.story_points}\n` : ''}${ctxText}\nDESCRIPTION:\n${bodyForLlm || '(empty)'}`;
  /* one small-model call per distinct task content; identical tickets are free to re-intake */
  const cacheKey = intakeCacheKey(fetched, opts.cfg.models.intake);
  const cachedOut = opts.noCache ? null : readJson<{ out: IntakeOut; model: string } | null>(intakeCacheFile(cacheKey), null);
  let out: IntakeOut;
  let cost = 0;
  let model: string;
  let cached = false;
  if (cachedOut) {
    out = cachedOut.out;
    model = cachedOut.model;
    cached = true;
  } else {
    const r = await opts.llm.complete<IntakeOut>({ kind: 'intake', model: opts.cfg.models.intake, system: INTAKE_SYSTEM, prompt, schema: INTAKE_SCHEMA as unknown as Record<string, unknown> });
    out = r.data;
    cost = r.cost_usd;
    model = r.model;
    writeJson(intakeCacheFile(cacheKey), { key: cacheKey, ts: new Date().toISOString(), model, out });
  }
  const MAX_CRITERIA = 8;
  const raw = (out.criteria ?? []).filter((c) => c.text?.trim());
  /* at most 8 criteria, explicit ones first: a long brief produced 19, which no receipt can grade sensibly */
  const kept = [...raw.filter((c) => c.source === 'explicit'), ...raw.filter((c) => c.source !== 'explicit')].slice(0, MAX_CRITERIA);
  const criteria: Task['criteria'] = kept.map((c, i) => {
    const check = sanitiseCheck(parseCheck(c.check));
    return { id: `c${i + 1}`, text: c.text.trim(), source: c.source === 'explicit' ? ('explicit' as const) : ('inferred' as const), kind: check ? ('mechanical' as const) : ('judgment' as const), ...(check ? { check } : {}) };
  });
  if (criteria.length === 0) criteria.push({ id: 'c1', text: `Deliver: ${fetched.title}`, source: 'inferred', kind: 'judgment' });
  /* repo policy: standing criteria the org appends to every task, checked mechanically where a check is given */
  const pol = loadPolicy(opts.cwd);
  for (const pc of pol.policy.criteria) {
    if (criteria.some((c) => c.text.trim().toLowerCase() === pc.text.trim().toLowerCase())) continue;
    const check = sanitiseCheck(pc.check ?? null);
    criteria.push({ id: `c${criteria.length + 1}`, text: pc.text.trim(), source: 'policy', kind: check ? 'mechanical' : 'judgment', ...(check ? { check } : {}) });
  }
  const r = { cost_usd: cost, model };
  const score = Math.max(0, Math.min(10, Number(out.spec_quality?.score ?? 0)));
  const estimate = computeEstimate(fetched, Number(out.estimate_hours ?? 0));
  const task: Task = {
    session: opts.session,
    cwd: opts.cwd,
    created_at: new Date().toISOString(),
    frozen: true,
    source: fetched.source as TaskSource & { kind: Task['source']['kind'] },
    title: out.title?.trim() || fetched.title,
    body_excerpt: fetched.body.slice(0, 1500),
    labels: fetched.labels,
    fetch_error: fetched.fetch_error,
    criteria,
    spec_quality: { score, missing: out.spec_quality?.missing ?? [], questions: out.spec_quality?.questions ?? [] },
    needs_clarification: score < 5,
    estimate,
    budget_usd: pol.policy.budget.usd ?? (pol.policy.budget.fraction ? Math.max(BUDGET_FLOOR_USD, Math.round(estimate.hours * (pol.policy.budget.hourly_rate ?? opts.cfg.hourly_rate) * pol.policy.budget.fraction * 100) / 100) : computeBudget(estimate.hours, pol.policy.budget.hourly_rate ?? opts.cfg.hourly_rate)),
    hourly_rate: pol.policy.budget.hourly_rate ?? opts.cfg.hourly_rate,
    tally_cost_usd: r.cost_usd,
    model: r.model,
    cache_key: cacheKey,
    cached,
    ...(opts.historical ? { historical: opts.historical } : {}),
    ...(inferred ? { inferred: true, confirmed: false, context: opts.context } : {}),
  };
  TaskSchema.parse(task);
  ensureDir(sessionDir(opts.session));
  writeJson(taskFile(opts.session), task);
  const pending = path.join(sessionDir(opts.session), 'task.pending');
  if (fs.existsSync(pending)) fs.unlinkSync(pending);
  appendEvent({
    ts: new Date().toISOString(),
    type: 'task',
    session: opts.session,
    cwd: opts.cwd,
    data: { title: task.title, criteria: task.criteria.length, spec_quality: task.spec_quality.score, needs_clarification: task.needs_clarification, budget_usd: task.budget_usd, estimate_hours: task.estimate.hours, source: task.source.kind },
  });
  return { task, created: true };
}

export function confirmTask(session: string): Task | null {
  const t = loadTask(session);
  if (!t) return null;
  t.confirmed = true;
  writeJson(taskFile(session), t);
  appendEvent({ ts: new Date().toISOString(), type: 'task', session, cwd: t.cwd, data: { confirmed: true, title: t.title } });
  return t;
}

export function renderTask(task: Task): string {
  const lines: string[] = [];
  lines.push(`Task: ${task.title}  [${task.inferred ? (task.confirmed ? 'inferred task (confirmed)' : 'inferred task (unconfirmed)') : task.source.kind}${task.source.url ? ' ' + task.source.url : ''}]`);
  if (task.fetch_error) lines.push(`  (fetch failed, used prompt text: ${task.fetch_error})`);
  lines.push(`Acceptance criteria (frozen):`);
  for (const c of task.criteria) lines.push(`  ${c.id}. ${c.text}${c.source === 'inferred' ? '  (inferred)' : c.source === 'policy' ? '  (repo policy)' : ''}  [${c.kind === 'mechanical' ? `mechanical: ${c.check?.kind}` : 'judgment'}]`);
  if (task.cached) lines.push(`  (intake served from cache; no model call)`);
  if (task.historical) lines.push(`  (historical: ${task.historical.note})`);
  lines.push(`Spec quality: ${task.spec_quality.score}/10${task.needs_clarification ? '  -> Clarify the ticket first' : ''}`);
  if (task.spec_quality.missing.length) lines.push(`  Missing: ${task.spec_quality.missing.join('; ')}`);
  if (task.needs_clarification && task.spec_quality.questions.length) {
    lines.push(`  Ask:`);
    for (const q of task.spec_quality.questions) lines.push(`   - ${q}`);
  }
  lines.push(`Estimate: ${task.estimate.hours}h human (${task.estimate.basis}${task.estimate.story_points ? `, ${task.estimate.story_points} SP` : ''})  Budget: $${task.budget_usd.toFixed(2)} API-equivalent`);
  return lines.join('\n');
}
