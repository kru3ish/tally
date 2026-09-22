import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { isolate, basicFixture, tmpDir } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { StubLlm, type LlmRequest } from '../src/llm/client.js';
import { selectTiers, trimDiff, buildTier1Prompt, mechanicalSummary, isCorrectnessCriterion, guardedConfidence, verdictSensitive, type Status } from '../src/judge/tiers.js';
import { resolveCheck, parseCheck, commandAllowed } from '../src/judge/checks.js';
import { judgeSession, existingReceiptFor, currentHead } from '../src/judge/judge.js';
import { intake, loadTask, intakeCacheFile } from '../src/task/intake.js';
import { readEventsFile, appendEvent } from '../src/store/events.js';
import { watch } from '../src/coach/ui.js';
import { loadFixtures, runFixture } from '../src/calibrate/eval.js';
import type { FetchDeps } from '../src/task/fetchers.js';
import type { Task } from '../src/task/intake.js';

let iso: ReturnType<typeof isolate>;
beforeEach(() => {
  iso = isolate();
});
afterEach(() => iso.restore());

const noFetch: FetchDeps = { exec: () => ({ ok: false, stdout: '', stderr: '' }), fetch: async () => ({ ok: false, status: 0, text: async () => '' }), readFile: () => '', exists: () => false };

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

function repo(): { cwd: string; base: string } {
  const cwd = tmpDir('tally-tier-');
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 't@t');
  git(cwd, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node test.js', lint: 'node -e 0' } }));
  fs.writeFileSync(path.join(cwd, 'test.js'), 'process.exit(0)');
  fs.writeFileSync(path.join(cwd, 'README.md'), '# app\n');
  fs.writeFileSync(path.join(cwd, 'src.js'), '1');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'base');
  const base = git(cwd, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(cwd, 'src.js'), 'module.exports = 429;\n');
  fs.writeFileSync(path.join(cwd, 'test.js'), 'if (require("./src.js") !== 429) process.exit(1)');
  return { cwd, base };
}

const events = (cwd: string, base: string) => readEventsFile(path.join(basicFixture, 'events.jsonl')).map((e) => (e.type === 'session_start' ? { ...e, cwd, data: { ...e.data, git_head: base } } : { ...e, cwd }));

function task(cwd: string, criteria: Task['criteria']): Task {
  return { session: 't', cwd, created_at: 'x', frozen: true, source: { kind: 'text', ref: 'x' }, title: 'T', body_excerpt: '', labels: [], criteria, spec_quality: { score: 7, missing: [], questions: [] }, needs_clarification: false, estimate: { hours: 2, basis: 'llm' }, budget_usd: 10, hourly_rate: 75, tally_cost_usd: 0, model: 'fixture' };
}

describe('tier selection', () => {
  it('picks tiers from criteria kinds, cost, --deep, and tier-1 confidence', () => {
    const none = selectTiers({ judgmentIds: [], sessionCostUsd: 50, deep: true, deepThreshold: 3, confidenceFloor: 0.6 });
    expect(none.run_tier1).toBe(false);
    expect(none.run_tier2).toBe(false);
    expect(none.explanation).toContain('tier 0 only');
    const cheap = selectTiers({ judgmentIds: ['c1', 'c2'], sessionCostUsd: 0.7, deep: false, deepThreshold: 3, confidenceFloor: 0.6 });
    expect(cheap.run_tier1).toBe(true);
    expect(cheap.run_tier2).toBe(false);
    const unsure = selectTiers({ judgmentIds: ['c1', 'c2'], sessionCostUsd: 0.7, deep: false, deepThreshold: 3, confidenceFloor: 0.6, tier1: [{ id: 'c1', status: 'met', confidence: 0.9 }, { id: 'c2', status: 'partial', confidence: 0.4 }] });
    expect(unsure.run_tier2).toBe(true);
    expect(unsure.tier2_criteria).toEqual(['c2']);
    const pricey = selectTiers({ judgmentIds: ['c1', 'c2'], sessionCostUsd: 3.5, deep: false, deepThreshold: 3, confidenceFloor: 0.6 });
    expect(pricey.run_tier2).toBe(true);
    expect(pricey.tier2_criteria).toEqual(['c1', 'c2']);
    const deep = selectTiers({ judgmentIds: ['c1'], sessionCostUsd: 0.1, deep: true, deepThreshold: 3, confidenceFloor: 0.6 });
    expect(deep.run_tier2).toBe(true);
    expect(deep.tier2_reasons).toEqual(['--deep']);
  });

  it('trims the diff to a token budget, prioritising hunks for named files', () => {
    const diff = ['diff --git a/a.js b/a.js\n' + 'x'.repeat(5000), 'diff --git a/README.md b/README.md\n' + 'y'.repeat(5000), 'diff --git a/z.js b/z.js\n' + 'z'.repeat(5000)].join('\n');
    const t = trimDiff(diff, ['README.md'], 6000);
    expect(t.truncated).toBe(true);
    expect(t.text.startsWith('diff --git a/README.md')).toBe(true);
    expect(t.text.length).toBeLessThanOrEqual(6100);
    expect(trimDiff('small', [], 100).truncated).toBe(false);
  });
});

describe('mechanical checks (tier 0)', () => {
  it('resolves file, diff, test, command and pr checks without a model', async () => {
    const { cwd, base } = repo();
    const stub = new StubLlm({ judge: () => { throw new Error('model must not be called'); } });
    const cfg = loadConfig();
    const t = task(cwd, [
      { id: 'c1', text: 'src returns 429', source: 'explicit', kind: 'mechanical', check: { kind: 'file_contains', path: 'src.js', pattern: '429' } },
      { id: 'c2', text: 'README documents it', source: 'explicit', kind: 'mechanical', check: { kind: 'file_changed', path: 'README.md' } },
      { id: 'c3', text: 'tests pass', source: 'explicit', kind: 'mechanical', check: { kind: 'tests_pass' } },
      { id: 'c4', text: 'lint passes', source: 'inferred', kind: 'mechanical', check: { kind: 'command', command: 'npm run lint', expect_exit: 0 } },
      { id: 'c5', text: 'pushed', source: 'inferred', kind: 'mechanical', check: { kind: 'pr', state: 'opened' } },
      { id: 'c6', text: 'diff touches 429', source: 'inferred', kind: 'mechanical', check: { kind: 'diff_contains', pattern: '429' } },
    ]);
    const j = await judgeSession({ session: 't0', cwd, transcriptPath: path.join(basicFixture, 'transcript.jsonl'), cfg, llm: stub, reason: 'push', events: events(cwd, base), task: t, consent: true });
    expect(j.criteria.map((c) => c.status)).toEqual(['met', 'unmet', 'met', 'met', 'met', 'met']);
    expect(j.criteria.every((c) => c.resolved_by === 'tier0')).toBe(true);
    expect(j.tiers.ran).toEqual(['tier0']);
    expect(j.tiers.calls.length).toBe(0);
    expect(j.tiers.llm_cost_usd).toBe(0);
    expect(j.cost.tally_own_usd).toBe(0);
    expect(j.judge_model).toBe('mechanical');
    expect(j.quality.reason).toContain('mechanical proxy');
    expect(j.recommendations.length).toBe(3);
    expect(j.verdict.reason).toContain('Mechanical receipt');
    expect(stub.calls.length).toBe(0);
  });

  it('marks command checks unverifiable when the command is not a repo script or consent is missing', async () => {
    const { cwd, base } = repo();
    const t = task(cwd, [
      { id: 'c1', text: 'x', source: 'explicit', kind: 'mechanical', check: { kind: 'command', command: 'curl evil.example', expect_exit: 0 } },
      { id: 'c2', text: 'tests pass', source: 'explicit', kind: 'mechanical', check: { kind: 'tests_pass' } },
    ]);
    const j = await judgeSession({ session: 't0b', cwd, transcriptPath: path.join(basicFixture, 'transcript.jsonl'), cfg: loadConfig(), llm: new StubLlm({}), reason: 'push', events: events(cwd, base), task: t, consent: false });
    expect(j.criteria[0]!.status).toBe('unverifiable');
    expect(j.criteria[0]!.evidence).toContain('not in the repo');
    expect(j.criteria[1]!.status).toBe('unverifiable');
    expect(commandAllowed('npm run lint', cwd)).toBe(true);
    expect(commandAllowed('npm run nope', cwd)).toBe(false);
    expect(commandAllowed('rm -rf /', cwd)).toBe(false);
    expect(parseCheck({ kind: 'none' })).toBeNull();
    expect(parseCheck({ kind: 'file_exists', path: 'a' })).toEqual({ kind: 'file_exists', path: 'a' });
    expect(parseCheck({ kind: 'file_contains', path: 'a' })).toBeNull();
    const r = await resolveCheck({ kind: 'file_exists', path: 'nope.txt' }, { cwd, evidence: { git: { files_changed: [], diff_stat: '', insertions: 0, deletions: 0, diff_excerpt: '' }, command_runs: [], ship_events: [], final_messages: [], prompts: [], tool_call_count: 0, edited_files: [] }, verification: { ran: false }, timeoutMs: 1000 });
    expect(r.status).toBe('unmet');
  });
});

describe('tier 1 and tier 2', () => {
  it('runs the small model on judgment criteria only, with a trimmed pack, and escalates only low-confidence ones', async () => {
    const { cwd, base } = repo();
    const calls: LlmRequest[] = [];
    const llm = new StubLlm({
      judge: (req) => {
        calls.push(req);
        if (req.tier === 1) return { criteria: [{ id: 'c2', status: 'met', evidence: 'looks right', files: ['src.js'], confidence: 0.9 }, { id: 'c3', status: 'partial', evidence: 'unsure', files: [], confidence: 0.3 }], quality_score: 6, quality_reason: 'r1', verdict_reason: 'v1', recommendations: ['a', 'b', 'c'] };
        return { criteria: [{ id: 'c2', status: 'met', evidence: 'confirmed', files: ['src.js'], confidence: 0.97 }, { id: 'c3', status: 'unmet', evidence: 'strong model says no', files: [], confidence: 0.95 }], quality_score: 7, quality_reason: 'r2', verdict_reason: 'v2', recommendations: ['d', 'e', 'f'] };
      },
    });
    const t = task(cwd, [
      { id: 'c1', text: 'tests pass', source: 'explicit', kind: 'mechanical', check: { kind: 'tests_pass' } },
      { id: 'c2', text: 'behaviour A', source: 'explicit', kind: 'judgment' },
      { id: 'c3', text: 'behaviour B', source: 'explicit', kind: 'judgment' },
    ]);
    const cfg = loadConfig();
    const j = await judgeSession({ session: 't12', cwd, transcriptPath: path.join(basicFixture, 'transcript.jsonl'), cfg, llm, reason: 'push', events: events(cwd, base), task: t, consent: true });
    expect(calls.map((c) => c.tier)).toEqual([1, 2]);
    expect(calls[0]!.model).toBe(cfg.models.tier1);
    expect(calls[0]!.prompt).toContain('c2: behaviour A');
    expect(calls[0]!.prompt).not.toContain('c1: tests pass');
    expect(Math.ceil(calls[0]!.prompt.length / 4)).toBeLessThanOrEqual(cfg.judge.tier1_evidence_tokens + 200);
    expect(calls[1]!.model).toBe(cfg.models.tier2_escalation);
    expect(calls[1]!.prompt).toContain('c3: behaviour B');
    /* c2 is verdict-sensitive (met→partial would drop the verdict), so the guard escalates it too */
    expect(calls[1]!.prompt).toContain('c2: behaviour A');
    expect(j.criteria.map((c) => [c.status, c.resolved_by])).toEqual([['met', 'tier0'], ['met', 'tier2'], ['unmet', 'tier2']]);
    expect(j.criteria[2]!.confidence).toBe(0.95);
    expect(j.tiers.ran).toEqual(['tier0', 'tier1', 'tier2']);
    expect(j.tiers.reason).toContain('verdict-sensitive');
    /* 0.1.1: completion is over verifiable criteria, so moving c3 one step no longer flips the verdict; it still escalates on confidence */
    expect(j.tiers.escalations).toEqual([{ id: 'c2', reason: 'verdict-sensitive' }, { id: 'c3', reason: 'low-confidence' }]);
    expect(j.verdict.reason).toBe('v2');
    expect(j.tiers.calls.map((c) => c.tier)).toEqual(['tier1', 'tier2']);
  });

  it('skips tier 1 and goes straight to the strong model above the deep threshold or with --deep', async () => {
    const { cwd, base } = repo();
    const calls: LlmRequest[] = [];
    const llm = new StubLlm({ judge: (req) => { calls.push(req); return { criteria: [{ id: 'c1', status: 'met', evidence: 'e', files: [], confidence: 1 }], quality_score: 8, quality_reason: 'r', verdict_reason: 'v', recommendations: ['a', 'b', 'c'] }; } });
    const t = task(cwd, [{ id: 'c1', text: 'behaviour', source: 'explicit', kind: 'judgment' }]);
    const cfg = loadConfig();
    await judgeSession({ session: 'deep', cwd, transcriptPath: path.join(basicFixture, 'transcript.jsonl'), cfg, llm, reason: 'manual', events: events(cwd, base), task: t, consent: true, deep: true });
    expect(calls.map((c) => c.tier)).toEqual([2]);
    cfg.judge.deepThreshold = 0.5;
    const j = await judgeSession({ session: 'pricey', cwd, transcriptPath: path.join(basicFixture, 'transcript.jsonl'), cfg, llm, reason: 'manual', events: events(cwd, base), task: t, consent: true });
    expect(calls.map((c) => c.tier)).toEqual([2, 2]);
    expect(j.tiers.reason).toContain('deepThreshold');
  });
});

describe('escalation guard', () => {
  it('caps confidence on partial/unmet correctness calls and flags verdict-sensitive criteria', () => {
    expect(isCorrectnessCriterion('POST /api/login returns 429 after 5 failed attempts')).toBe(true);
    expect(isCorrectnessCriterion('README documents the limit')).toBe(false);
    expect(guardedConfidence('Login returns 429', 'unmet', 0.9)).toBe(0.5);
    expect(guardedConfidence('Login returns 429', 'met', 0.9)).toBe(0.9);
    expect(guardedConfidence('README documents the limit', 'unmet', 0.9)).toBe(0.9);
    const verdictOf = (st: Record<string, Status>) => {
      const v = Object.values(st);
      const pct = ((v.filter((s) => s === 'met').length + 0.5 * v.filter((s) => s === 'partial').length) / v.length) * 100;
      return pct >= 70 ? 'worth it' : pct >= 40 ? 'borderline' : 'not worth it';
    };
    expect(verdictSensitive({ statuses: { c1: 'met', c2: 'met', c3: 'met', c4: 'met' }, id: 'c1', verdictOf })).toBe(false);
    expect(verdictSensitive({ statuses: { c1: 'met', c2: 'met', c3: 'unmet', c4: 'unmet' }, id: 'c1', verdictOf })).toBe(true);
    const d = selectTiers({ judgmentIds: ['c1', 'c2'], sessionCostUsd: 0.7, deep: false, deepThreshold: 3, confidenceFloor: 0.6, tier1: [{ id: 'c1', status: 'unmet', confidence: 0.9, adjusted_confidence: 0.5 }, { id: 'c2', status: 'met', confidence: 0.95, verdict_sensitive: true }] });
    expect(d.run_tier2).toBe(true);
    expect(d.tier2_criteria.sort()).toEqual(['c1', 'c2']);
    expect(d.escalations).toEqual([{ id: 'c1', reason: 'correctness' }, { id: 'c2', reason: 'verdict-sensitive' }]);
    expect(d.explanation).toContain('verdict-sensitive');
  });

  it('rate-limit-partial: tier 1 calls the 429 criterion unmet, so tier 2 re-judges it on the escalation model', async () => {
    const { cwd, base } = repo();
    const calls: LlmRequest[] = [];
    const llm = new StubLlm({
      judge: (req) => {
        calls.push(req);
        if (req.tier === 1) return { criteria: [{ id: 'c1', status: 'unmet', evidence: 'no 15 minute window', files: ['src.js'], confidence: 0.9 }], quality_score: 6, quality_reason: 'r1', verdict_reason: 'v1', recommendations: ['a', 'b', 'c'] };
        return { criteria: [{ id: 'c1', status: 'partial', evidence: 'counts attempts but never expires them', files: ['src.js'], confidence: 0.85 }], quality_score: 6, quality_reason: 'r2', verdict_reason: 'v2', recommendations: ['d', 'e', 'f'] };
      },
    });
    const t = task(cwd, [
      { id: 'c1', text: 'POST /api/login returns 429 after 5 failed attempts from one IP within 15 minutes', source: 'explicit', kind: 'judgment' },
      { id: 'c2', text: 'A test covers the 429 path', source: 'explicit', kind: 'mechanical', check: { kind: 'file_contains', path: 'test.js', pattern: '429' } },
      { id: 'c3', text: 'README documents the limit', source: 'explicit', kind: 'mechanical', check: { kind: 'file_changed', path: 'README.md' } },
      { id: 'c4', text: 'Existing login behaviour is unchanged below the limit', source: 'inferred', kind: 'mechanical', check: { kind: 'tests_pass' } },
    ]);
    const cfg = loadConfig();
    const j = await judgeSession({ session: 'guard', cwd, transcriptPath: path.join(basicFixture, 'transcript.jsonl'), cfg, llm, reason: 'push', events: events(cwd, base), task: t, consent: true });
    expect(calls.map((c) => c.tier)).toEqual([1, 2]);
    expect(calls[1]!.model).toBe(cfg.models.tier2_escalation);
    expect(calls[1]!.prompt).toContain('c1:');
    expect(Math.ceil(calls[1]!.prompt.length / 4)).toBeLessThanOrEqual(cfg.judge.tier2_escalation_tokens + 300);
    expect(j.criteria[0]).toMatchObject({ status: 'partial', resolved_by: 'tier2' });
    expect(j.tiers.escalations).toEqual([{ id: 'c1', reason: 'correctness' }]);
    expect(j.tiers.reason).toContain('correctness');
    expect(j.tiers.calls.map((c) => c.tier)).toEqual(['tier1', 'tier2']);
    expect(j.completion_pct).toBe(62.5);
  });
});

describe('intake cache and receipt dedupe', () => {
  it('caches intake by task content so a re-intake makes no model call', async () => {
    const llm = new StubLlm({ intake: () => ({ title: 'T', criteria: [{ text: 'README documents it', source: 'explicit', check: { kind: 'file_changed', path: 'README.md' } }, { text: 'works well', source: 'inferred', check: { kind: 'none' } }], spec_quality: { score: 7, missing: [], questions: [] }, estimate_hours: 1, rationale: '' }) });
    const a = await intake({ session: 'i1', cwd: 'C:/x', text: 'Document the limit in README', cfg: loadConfig(), llm, deps: noFetch });
    expect(llm.calls.length).toBe(1);
    expect(a.task.criteria[0]!.kind).toBe('mechanical');
    expect(a.task.criteria[0]!.check).toEqual({ kind: 'file_changed', path: 'README.md' });
    expect(a.task.criteria[1]!.kind).toBe('judgment');
    expect(a.task.cached).toBe(false);
    expect(fs.existsSync(intakeCacheFile(a.task.cache_key!))).toBe(true);
    const b = await intake({ session: 'i2', cwd: 'C:/x', text: 'Document the limit in README', cfg: loadConfig(), llm, deps: noFetch });
    expect(llm.calls.length).toBe(1);
    expect(b.task.cached).toBe(true);
    expect(b.task.tally_cost_usd).toBe(0);
    expect(b.task.criteria).toEqual(a.task.criteria);
    await intake({ session: 'i3', cwd: 'C:/x', text: 'Something else entirely', cfg: loadConfig(), llm, deps: noFetch });
    expect(llm.calls.length).toBe(2);
    await intake({ session: 'i4', cwd: 'C:/x', text: 'Document the limit in README', cfg: loadConfig(), llm, deps: noFetch, noCache: true });
    expect(llm.calls.length).toBe(3);
    expect(loadTask('i2')!.cached).toBe(true);
  });

  it('push and session-end triggers for the same HEAD share one receipt; a new commit re-judges', async () => {
    const { cwd, base } = repo();
    const llm = new StubLlm({ judge: () => ({ criteria: [{ id: 'c1', status: 'met', evidence: 'e', files: [], confidence: 1 }], quality_score: 8, quality_reason: 'r', verdict_reason: 'v', recommendations: ['a', 'b', 'c'] }) });
    const t = task(cwd, [{ id: 'c1', text: 'behaviour', source: 'explicit', kind: 'judgment' }]);
    const j = await judgeSession({ session: 'dd', cwd, transcriptPath: path.join(basicFixture, 'transcript.jsonl'), cfg: loadConfig(), llm, reason: 'push', events: events(cwd, base), task: t, consent: true });
    expect(j.head).toBe(currentHead(cwd));
    expect(existingReceiptFor('dd', cwd)?.reason).toBe('push');
    git(cwd, 'commit', '-q', '-am', 'more work');
    expect(existingReceiptFor('dd', cwd)).toBeNull();
  });
});

describe('coach llm gate', () => {
  it('makes no LLM call for sessions under $1 but still runs deterministic rules', async () => {
    const fixtureEvents = readEventsFile(path.join(basicFixture, 'events.jsonl'));
    const session = 'cheap';
    const cwd = tmpDir('tally-cheap-');
    for (const e of fixtureEvents) appendEvent({ ...e, session, cwd });
    const out = new PassThrough();
    let text = '';
    out.on('data', (d: Buffer) => (text += d.toString()));
    const cfg = loadConfig();
    cfg.coach.min_interval_s = 0;
    let llmCalls = 0;
    const llm = new StubLlm({ coach: () => { llmCalls += 1; return { has_suggestion: true, title: 'x', message: 'y', severity: 'info', usd_saved: 1 }; } });
    let t = Date.parse('2026-09-10T15:00:00Z');
    await watch({ session, cwd, cfg, color: false, pollMs: 5, maxTicks: 3, output: out as unknown as NodeJS.WriteStream, input: new PassThrough() as unknown as NodeJS.ReadStream, now: () => new Date((t += 200000)), llm, once: false });
    expect(llmCalls).toBe(0);
    expect(text).toContain('Same command failed 3');
    expect(text).toContain('once the session passes $1');
  });
});

describe('fixture replay with recorded tiers', () => {
  it('replays recorded tier calls and books their recorded cost as self-spend', async () => {
    const c = loadFixtures().find((x) => x.name === 'health-endpoint-complete')!;
    if (!c.recorded) return;
    const r = await runFixture(c, { cfg: loadConfig() });
    expect(r.judge.tiers.ran[0]).toBe('tier0');
    expect(r.judge.criteria.filter((x) => x.resolved_by === 'tier0').length).toBeGreaterThanOrEqual(2);
    expect(r.judge.cost.tally_own_usd).toBeCloseTo(c.recorded.calls.reduce((s, x) => s + x.cost_usd, 0), 4);
  }, 60000);
});
