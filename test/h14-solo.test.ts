import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { isolate, tmpDir, root, basicFixture } from './helpers.js';
import { buildOnboard, renderOnboard } from '../src/commands/onboard.js';
import { buildReplay, renderReplay } from '../src/commands/replay.js';
import { comparePrompts, promptFeatures } from '../src/commands/prompts.js';
import { invoiceRows, renderInvoice } from '../src/commands/export.js';
import { extractJson, OpenAICompatible } from '../src/llm/openai.js';
import { makeLlm } from '../src/llm/client.js';
import { loadConfig, saveConfig } from '../src/config.js';
import { computeTrend, renderTrend } from '../src/report/report.js';
import { parseTranscriptFile } from '../src/transcript/parse.js';
import type { HistoryEntry } from '../src/coach/types.js';

const HOOK = path.join(root, 'dist', 'hook.js');
const CLI = path.join(root, 'dist', 'cli.js');

let iso: ReturnType<typeof isolate>;
beforeEach(() => {
  iso = isolate();
});
afterEach(() => iso.restore());

function seedProjects(): string {
  const projects = path.join(iso.claude, 'projects', 'C--Users-dev-acme-app');
  fs.mkdirSync(projects, { recursive: true });
  fs.copyFileSync(path.join(basicFixture, 'transcript.jsonl'), path.join(projects, 'fx-basic-0001-4c0d-8e1a-000000000001.jsonl'));
  return projects;
}

describe('onboard (instant report, no model calls)', () => {
  it('sums spend, ranks sessions, names one habit and compares plans from the transcripts on disk', () => {
    seedProjects();
    const r = buildOnboard('365d', Date.parse('2026-09-16T00:00:00Z'));
    expect(r.sessions).toBe(1);
    expect(r.spend_usd).toBeGreaterThan(0);
    expect(r.top[0]!.repo).toContain('acme-app');
    expect(r.habit.length).toBeGreaterThan(10);
    expect(r.plans!.map((p) => p.name)).toContain('Pro');
    const text = renderOnboard(r);
    expect(text).toContain('Most expensive sessions');
    expect(text).toContain('Where money went that bought nothing');
    expect(text).toContain('Pro');
  });

  it('runs from the CLI without a model and prints JSON on request', () => {
    seedProjects();
    const r = spawnSync(process.execPath, [CLI, 'onboard', '--since', '3650d', '--json'], { encoding: 'utf8', env: { ...process.env, TALLY_LLM: 'stub' } });
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout) as { sessions: number };
    expect(j.sessions).toBe(1);
  });
});

describe('replay', () => {
  it('marks prompts, first edits, loops, context pressure and compactions in time order', () => {
    const t = parseTranscriptFile(path.join(basicFixture, 'transcript.jsonl'));
    const m = buildReplay(t, { contextWindow: 200000 });
    expect(m[0]!.kind).toBe('prompt');
    expect(m.some((x) => x.kind === 'edit')).toBe(true);
    for (let i = 1; i < m.length; i++) expect(m[i]!.ts >= m[i - 1]!.ts).toBe(true);
    const text = renderReplay('fx-basic-0001', m, { title: 'rate limit login', total: t.cost });
    expect(text).toContain('Replay · fx-basic');
    expect(text).toContain('Off-track moments');
  });

  it('counts a loop once at the third identical failure', () => {
    const t = parseTranscriptFile(path.join(basicFixture, 'transcript.jsonl'));
    const base = t.toolCalls[0]!;
    const fails = [1, 2, 3, 4].map((i) => ({ ...base, id: `f${i}`, name: 'Bash', input: { command: 'npm test' }, ts: `2026-09-10T15:0${i}:00.000Z`, result: { isError: true, chars: 10, text: 'FAIL' } }));
    const m = buildReplay({ ...t, toolCalls: fails, prompts: [], compactions: [] }, { contextWindow: 200000 });
    expect(m.filter((x) => x.kind === 'loop').length).toBe(1);
    expect(m.filter((x) => x.kind === 'first-failing-test').length).toBe(1);
  });
});

describe('prompts', () => {
  it('extracts plain features from a prompt', () => {
    const f = promptFeatures('Add rate limiting to src/routes/login.ts. Verify with npm test. Do not touch the auth middleware.\n- 429 after 5 tries\n- README note');
    expect(f.names_test_command).toBe(true);
    expect(f.lists_files).toBe(true);
    expect(f.states_constraints).toBe(true);
    expect(f.has_acceptance_list).toBe(true);
    expect(f.links_ticket).toBe(false);
  });

  it('compares the best half with the worst half and offers a template', () => {
    const good = 'Fix login.ts; verify with npm test; do not change the schema.\n- returns 429\n- test added';
    const bad = 'make login better';
    const c = comparePrompts([
      { text: good, completion: 100 },
      { text: good, completion: 90 },
      { text: bad, completion: 20 },
      { text: bad, completion: 10 },
    ]);
    const tests = c.findings.find((f) => f.feature === 'names the test command')!;
    expect(tests.good_pct).toBe(100);
    expect(tests.poor_pct).toBe(0);
    expect(c.template).toContain('Verify with');
  });
});

describe('export --invoice', () => {
  it('renders markdown and CSV lines with a total, without prompts or code', () => {
    const entries: HistoryEntry[] = [{ session: 'abcdefgh-1', ts: '2026-09-10T15:00:00Z', task_title: 'rate limit | login', cost_usd: 1.5, verdict: 'worth it', completion_pct: 100 } as HistoryEntry];
    const rows = invoiceRows(entries);
    expect(rows[0]!.task).toBe('rate limit | login');
    const md = renderInvoice(rows, 'md');
    expect(md).toContain('rate limit \\| login');
    expect(md).toContain('Total AI cost (API-equivalent): $1.50');
    const csv = renderInvoice(rows, 'csv');
    expect(csv.split('\n')[0]).toBe('date,task,criteria_met,independent_test,estimate_hours,ai_cost_usd,verdict,session');
  });
});

describe('estimation feedback in the report', () => {
  it('buckets receipts by estimated hours and prints completion and cost per estimated hour', () => {
    const h = (estimate_hours: number, cost_usd: number, completion_pct: number): HistoryEntry => ({ session: `s${estimate_hours}${cost_usd}`, ts: '2026-09-10T15:00:00Z', verdict: 'worth it', estimate_hours, cost_usd, completion_pct } as HistoryEntry);
    const t = computeTrend({ history: [h(0.5, 1, 100), h(2, 4, 60), h(8, 20, 30)] });
    expect(t.estimation.map((e) => e.bucket)).toEqual(['≤ 1 h', '1–4 h', '> 4 h']);
    expect(t.estimation[2]!.avg_cost_per_est_hour).toBeCloseTo(2.5);
    expect(renderTrend(t)).toContain('Estimate vs outcome');
  });
});

describe('local-model provider (OpenAI-compatible)', () => {
  it('parses fenced or bare JSON', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure: {"a":2} done')).toEqual({ a: 2 });
    expect(() => extractJson('no json here')).toThrow();
  });

  it('talks to a chat/completions endpoint and records zero cost by default', async () => {
    const seen: unknown[] = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ model: 'llama3', choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    try {
      const llm = new OpenAICompatible({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', session: 'local-test' });
      const r = await llm.complete<{ ok: boolean }>({ kind: 'coach', model: 'llama3', system: 'sys', prompt: 'hi', schema: { type: 'object' } });
      expect(r.data.ok).toBe(true);
      expect(r.cost_usd).toBe(0);
      expect(r.model).toBe('local:llama3');
      const s = seen[0] as { url: string; auth: string; body: { model: string; messages: Array<{ role: string }> } };
      expect(s.url).toBe('/v1/chat/completions');
      expect(s.auth).toBe('Bearer k');
      expect(s.body.messages.map((m) => m.role)).toEqual(['system', 'user']);
    } finally {
      srv.close();
    }
  });

  it('is selected by models.provider in config', () => {
    const cfg = loadConfig();
    expect(cfg.models.provider).toBe('claude');
    cfg.models.provider = 'openai-compatible';
    cfg.models.base_url = 'http://127.0.0.1:1/v1';
    saveConfig(cfg);
    expect(makeLlm()).toBeInstanceOf(OpenAICompatible);
  });
});

describe('handoff resume', () => {
  it('SessionStart surfaces a fresh HANDOFF.md as the state to resume from, and ignores a stale one', () => {
    const cwd = tmpDir('tally-handoff-');
    fs.writeFileSync(path.join(cwd, 'HANDOFF.md'), '# Handoff\nNext: wire the rate limiter into login.\n');
    const run = () => spawnSync(process.execPath, [HOOK, 'SessionStart'], { input: JSON.stringify({ session_id: 'handoff-0001', cwd, source: 'startup' }), encoding: 'utf8', env: { ...process.env, TALLY_NO_SPAWN: '1' } });
    let r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('HANDOFF.md');
    expect(r.stdout).toContain('wire the rate limiter');
    const old = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    fs.utimesSync(path.join(cwd, 'HANDOFF.md'), old, old);
    r = run();
    expect(r.stdout).not.toContain('HANDOFF.md');
  });
});

describe('session-end judging waits for intake', () => {
  it('waitForIntake returns once task.json lands and gives up after maxMs', async () => {
    const { waitForIntake, receiptPredatesTask } = await import('../src/commands/finalize.js');
    const { sessionDir, writeJson } = await import('../src/paths.js');
    const session = 'race-0001';
    const dir = sessionDir(session);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'task.pending'), 'task.md');
    setTimeout(() => writeJson(path.join(dir, 'task.json'), { criteria: [] }), 60);
    const waited = await waitForIntake(session, 5000, 10);
    expect(waited).toBeGreaterThanOrEqual(50);
    expect(waited).toBeLessThan(3000);
    fs.unlinkSync(path.join(dir, 'task.json'));
    const gaveUp = await waitForIntake(session, 40, 10);
    expect(gaveUp).toBeGreaterThanOrEqual(40);
    expect(receiptPredatesTask(session)).toBe(false);
  });

  it('receiptPredatesTask is true when the frozen task is newer than the receipt', async () => {
    const { receiptPredatesTask } = await import('../src/commands/finalize.js');
    const { sessionDir, writeJson } = await import('../src/paths.js');
    const session = 'race-0002';
    const dir = sessionDir(session);
    fs.mkdirSync(dir, { recursive: true });
    const judge = { judged_at: new Date(Date.now() - 60000).toISOString() };
    writeJson(path.join(dir, 'judge.json'), judge);
    writeJson(path.join(dir, 'task.json'), { criteria: [] });
    expect(receiptPredatesTask(session)).toBe(true);
    judge.judged_at = new Date(Date.now() + 60000).toISOString();
    writeJson(path.join(dir, 'judge.json'), judge);
    expect(receiptPredatesTask(session)).toBe(false);
  });
});
