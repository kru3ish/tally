import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isolate, tmpDir } from './helpers.js';
import { findOpportunities, quietFlag } from '../src/estimate/opportunities.js';
import { applyFix } from '../src/estimate/variance.js';
import { loadPricing, costOf } from '../src/cost/pricing.js';
import type { Transcript, ToolCall, AssistantMessage, Phase } from '../src/transcript/parse.js';

let iso: ReturnType<typeof isolate>;
beforeEach(() => {
  iso = isolate();
});
afterEach(() => iso.restore());
const pricing = loadPricing();

/* a synthetic transcript: n main-loop messages, each with `ctx` tokens of context, plus the given tool calls */
function transcript(opts: { model?: string; n?: number; ctx?: number; out?: number; calls?: Array<Partial<ToolCall> & { name: string }>; phase?: (i: number) => Phase }): Transcript {
  const model = opts.model ?? 'claude-opus-5-5';
  const messages: AssistantMessage[] = [];
  for (let i = 0; i < (opts.n ?? 20); i++) {
    const usage = { input: 10, output: opts.out ?? 500, cache_write: 1000, cache_read: opts.ctx ?? 20000 };
    messages.push({ id: `m${i}`, ts: new Date(Date.UTC(2026, 9, 18, 10, 0, i)).toISOString(), model, usage, cost: costOf(usage, model, pricing), agent: 'main', turn: 1, phase: opts.phase?.(i) ?? 'build', text: '', toolUseIds: [], afterCompaction: false });
  }
  const toolCalls: ToolCall[] = (opts.calls ?? []).map((c, i) => ({ id: `t${i}`, input: {}, ts: messages[Math.min(i, messages.length - 1)]!.ts, agent: 'main', messageId: messages[Math.min(i, messages.length - 1)]!.id, turn: 1, phase: 'build', ...c }) as ToolCall);
  return { sessionId: 's', models: [model], prompts: [], messages, toolCalls, compactions: [], mcpCalls: [], skills: [], cost: messages.reduce((s, m) => s + m.cost, 0) } as unknown as Transcript;
}

const ids = (t: Transcript, extra: Parameters<typeof findOpportunities>[1] extends infer O ? Partial<O> : never = {}) => findOpportunities(t, { pricing, ...extra }).map((d) => d.id);

describe('what to add, from the transcript', () => {
  it('a session with nothing unusual suggests nothing', () => {
    expect(ids(transcript({}))).toEqual([]);
  });

  it('a context that ran far past 200k suggests compacting earlier, with a one-line setting', () => {
    const t = transcript({ n: 40, ctx: 600000 });
    const d = findOpportunities(t, { pricing }).find((x) => x.id === 'compact-window')!;
    expect(d.group).toBe('add');
    expect(d.usd).toBeGreaterThan(1);
    expect(d.fix!.apply).toEqual({ kind: 'settings', patch: { autoCompactWindow: 200000 }, scope: 'project' });
  });

  it('exploration on an expensive model suggests a Haiku scout subagent and the story as a skill', () => {
    const calls = Array.from({ length: 10 }, (_, i) => ({ name: i % 2 ? 'Grep' : 'Read', phase: 'explore' as Phase, input: { file_path: `/r/src/f${i}.ts` } }));
    calls.push({ name: 'Edit', phase: 'build', input: { file_path: '/r/src/a.ts' } } as never, { name: 'Edit', phase: 'build', input: { file_path: '/r/src/b.ts' } } as never);
    const t = transcript({ n: 20, ctx: 60000, calls, phase: (i) => (i < 12 ? 'explore' : 'build') });
    const got = ids(t, { story: 'Add rate limiting', cwd: '/r' });
    expect(got).toContain('scout');
    expect(got).toContain('story-skill');
  });

  it('documentation fetched from the web suggests Context7, unless it is already installed', () => {
    const calls = [0, 1, 2].map(() => ({ name: 'WebFetch', input: { url: 'https://docs.python.org/3/library/asyncio.html' }, result: { isError: false, chars: 60000, text: '' } }));
    expect(ids(transcript({ calls }))).toContain('docs');
    expect(ids(transcript({ calls }), { loaded: { mcp: ['context7'] } })).not.toContain('docs');
  });

  it('large source files read whole suggest Serena; docs, logs and saved tool results do not', () => {
    const big = { isError: false, chars: 60000, text: '' };
    const code = [1, 2, 3].map((i) => ({ name: 'Read', input: { file_path: `/r/src/big${i}.ts` }, result: big }));
    const notCode = [{ name: 'Read', input: { file_path: '/r/plan.md' }, result: big }, { name: 'Read', input: { file_path: '/home/u/.claude/projects/x/tool-results/a.txt' }, result: big }, { name: 'Read', input: { file_path: '/r/node_modules/x/index.js' }, result: big }];
    expect(ids(transcript({ calls: code }))).toContain('big-reads');
    expect(ids(transcript({ calls: [...notCode, ...notCode] }))).not.toContain('big-reads');
  });

  it('noisy test output suggests a run-tests skill with the quiet reporter, and big outputs a cap', () => {
    const calls = [0, 1, 2].map(() => ({ name: 'Bash', input: { command: 'npx vitest run' }, result: { isError: false, chars: 40000, text: '' } }));
    const got = ids(transcript({ calls }));
    expect(got).toContain('noisy-tests');
    expect(got).toContain('bash-output');
    expect(quietFlag('npx vitest run')).toBe('npx vitest run --reporter=dot');
    expect(quietFlag('pytest tests/')).toBe('pytest tests/ -q --no-header -rN');
  });

  it('a file fix creates the subagent or skill, never overwrites one, and undoes cleanly', async () => {
    const cwd = tmpDir('tally-add-');
    const calls = Array.from({ length: 8 }, () => ({ name: 'Read', phase: 'explore' as Phase }));
    const scout = findOpportunities(transcript({ n: 20, ctx: 60000, calls, phase: (i) => (i < 12 ? 'explore' : 'build') }), { pricing }).find((d) => d.id === 'scout')!;
    const r = applyFix(scout.fix!, { session: 'add-1', cwd });
    expect(r.ok).toBe(true);
    const file = path.join(cwd, '.claude', 'agents', 'scout.md');
    expect(fs.readFileSync(file, 'utf8')).toMatch(/model: haiku/);
    expect(applyFix(scout.fix!, { session: 'add-1', cwd }).detail).toContain('not overwritten');
    const { undoLast } = await import('../src/coach/undo.js');
    undoLast(1);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('applying from the page or the session', () => {
  it('`tally fix all` applies every change Tally writes, and a copied command finds its check from the folder', async () => {
    const { spawnSync } = await import('node:child_process');
    const { root, basicFixture } = await import('./helpers.js');
    const { computeCheck } = await import('../src/estimate/variance.js');
    const { parseTranscriptFile } = await import('../src/transcript/parse.js');
    const { sessionDir } = await import('../src/paths.js');
    const cwd = tmpDir('tally-fixall-');
    spawnSync('git', ['init', '-q'], { cwd });
    const session = 'fixall-0001';
    fs.mkdirSync(sessionDir(session), { recursive: true });
    fs.writeFileSync(path.join(sessionDir(session), 'events.jsonl'), JSON.stringify({ ts: new Date().toISOString(), type: 'session_start', session, cwd, data: {} }) + '\n');
    const t = parseTranscriptFile(path.join(basicFixture, 'transcript.jsonl'));
    computeCheck(session, { transcript: t, estimate: null });
    const CLI = path.join(root, 'dist', 'cli.js');
    const one = spawnSync(process.execPath, [CLI, 'fix', 'model-sonnet'], { cwd, encoding: 'utf8', env: process.env });
    expect(one.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8')).model).toBe('sonnet');
    const all = spawnSync(process.execPath, [CLI, 'fix', 'all'], { cwd, encoding: 'utf8', env: process.env });
    expect(all.status).toBe(0);
    expect(all.stdout).toMatch(/\d+\/\d+ applied/);
    expect(fs.existsSync(path.join(cwd, 'CLAUDE.md'))).toBe(true);
  });

  it('a "why" line is one whole sentence, not cut at e.g. or a semicolon', async () => {
    const { firstSentence } = await import('../src/estimate/actions.js');
    expect(firstSentence('the main loop cost $9; at Sonnet $3. Sonnet may need more turns.')).toBe('The main loop cost $9; at Sonnet $3.');
    expect(firstSentence('5 files (e.g. a.ts, b.ts) were read. More text.')).toBe('5 files (e.g. a.ts, b.ts) were read.');
  });
});
