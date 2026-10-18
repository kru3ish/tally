import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolate, root, basicFixture, tmpDir } from './helpers.js';
import { buildCorpus, estimateFromCorpus, backtest, tokenize, storyText, type CorpusDoc } from '../src/estimate/estimate.js';
import { computeCheck, renderCheck, applyFix, findFix, headline } from '../src/estimate/variance.js';
import { parseTranscriptFile } from '../src/transcript/parse.js';
import { undoLast } from '../src/coach/undo.js';
import { sessionDir, writeJson } from '../src/paths.js';
import { renderStatusLine } from '../src/commands/statusline.js';
import { appendEvent } from '../src/store/events.js';

const HOOK = path.join(root, 'dist', 'hook.js');
const CLI = path.join(root, 'dist', 'cli.js');
let iso: ReturnType<typeof isolate>;
beforeEach(() => {
  iso = isolate();
});
afterEach(() => iso.restore());

/* a minimal past Claude Code session: one prompt, one priced assistant call with a tool use */
function pastSession(projects: string, id: string, cwd: string, prompt: string, outputTokens: number): void {
  const dir = path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const base = { cwd, sessionId: id, version: '2.1.268', entrypoint: 'cli', isSidechain: false, userType: 'external' };
  const lines = [
    { ...base, type: 'user', uuid: `${id}-u1`, timestamp: new Date(Date.now() - 3600_000).toISOString(), message: { role: 'user', content: prompt } },
    {
      ...base,
      type: 'assistant',
      uuid: `${id}-a1`,
      timestamp: new Date(Date.now() - 3500_000).toISOString(),
      message: { model: 'claude-opus-5', id: `msg-${id}`, role: 'assistant', content: [{ type: 'tool_use', id: `tu-${id}`, name: 'Read', input: { file_path: `${cwd}/a.js` } }], usage: { input_tokens: 10, output_tokens: outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    },
  ];
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function corpusDoc(session: string, text: string, cost: number, repo = '/r'): CorpusDoc {
  return { session, text, cost_usd: cost, repo, models: ['claude-opus-5'] };
}

describe('estimate: a price tag from similar past stories', () => {
  it('tokenizes away stopwords, numbers and pasted-content tags', () => {
    expect(tokenize('<pasted_content id="1">Fix the login rate limit 429</pasted_content>')).toEqual(['fix', 'login', 'rate', 'limit']);
  });

  it('uses the most similar stories, weighted, with a range', () => {
    const corpus = [
      corpusDoc('a', 'rate limit the login endpoint with redis', 40),
      corpusDoc('b', 'add rate limiting to the login api', 50),
      corpusDoc('c', 'login endpoint rate limit returns 429', 60),
      corpusDoc('d', 'update the README badges', 2),
      corpusDoc('e', 'bump dependencies', 1),
      corpusDoc('f', 'write the changelog', 1.5),
    ];
    const e = estimateFromCorpus('Rate limit the login endpoint', corpus);
    expect(e.basis).toBe('similar');
    expect(e.n).toBe(3);
    expect(e.usd).toBeGreaterThanOrEqual(40);
    expect(e.usd).toBeLessThanOrEqual(60);
    expect(e.low_usd).toBeLessThanOrEqual(e.usd);
    expect(e.high_usd).toBeGreaterThanOrEqual(e.usd);
    expect(e.neighbours.map((n) => n.session)).not.toContain('d');
  });

  it('falls back to the repo median, then everything, and says so', () => {
    const corpus = [corpusDoc('a', 'alpha beta', 1, '/x'), corpusDoc('b', 'gamma delta', 3, '/x'), corpusDoc('c', 'epsilon zeta', 5, '/x'), corpusDoc('d', 'eta theta', 100, '/y')];
    const repo = estimateFromCorpus('something unrelated entirely', corpus, { cwd: '/x' });
    expect(repo.basis).toBe('repo');
    expect(repo.usd).toBe(3);
    expect(repo.confidence).toBe('low');
    const all = estimateFromCorpus('something unrelated entirely', corpus, { cwd: '/nowhere' });
    expect(all.basis).toBe('all');
    expect(estimateFromCorpus('x', []).basis).toBe('none');
  });

  it('never estimates a session from itself, nor from word-for-word copies in the backtest', () => {
    const corpus = [corpusDoc('a', 'same harness prompt', 1), corpusDoc('b', 'same harness prompt', 100), corpusDoc('c', 'other work entirely', 10)];
    expect(estimateFromCorpus('same harness prompt', corpus, { exclude: 'a' }).neighbours.map((n) => n.session)).not.toContain('a');
    const b = backtest(corpus);
    expect(b.sessions).toBe(3);
    expect(b.by_basis.similar ?? 0).toBe(0);
  });

  it('reads a story that lives in a referenced .md file', () => {
    const cwd = tmpDir('tally-story-');
    fs.writeFileSync(path.join(cwd, 'plan.md'), '# Build a snake game in canvas\n');
    expect(storyText(['plan.md is the task'], cwd)).toContain('snake game');
    expect(storyText(['../outside.md is the task'], cwd)).not.toContain('snake');
  });

  it('builds its corpus from the transcripts already on disk, skipping sessions where the agent did nothing', () => {
    const projects = path.join(iso.claude, 'projects');
    pastSession(projects, 's1', '/work/app', 'rate limit the login endpoint', 4000);
    pastSession(projects, 's2', '/work/app', 'add a rate limit to login', 8000);
    const corpus = buildCorpus();
    expect(corpus.map((d) => d.session).sort()).toEqual(['s1', 's2']);
    expect(corpus.every((d) => d.cost_usd > 0)).toBe(true);
    const r = spawnSync(process.execPath, [CLI, 'estimate', 'Rate limit login'], { encoding: 'utf8', env: process.env });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('similar past stories');
    expect(r.stdout).toContain('Nothing was sent anywhere');
  });
});

describe('cost check: estimate vs actual, drivers and one-line fixes', () => {
  function checked(session: string, estimateUsd: number) {
    const t = parseTranscriptFile(path.join(basicFixture, 'transcript.jsonl'));
    const cwd = tmpDir('tally-cost-');
    appendEvent({ ts: new Date().toISOString(), type: 'session_start', session, cwd, data: { loaded: { mcp: ['notion', 'linear'], skills: [], plugins: [] } } });
    const estimate = { usd: estimateUsd, low_usd: estimateUsd * 0.8, high_usd: estimateUsd * 1.2, basis: 'similar' as const, confidence: 'medium' as const, n: 4, corpus: 10, neighbours: [], computed_at: new Date().toISOString() };
    return { t, cwd, check: computeCheck(session, { transcript: t, estimate }) };
  }

  it('calls an overage, names the drivers and offers the model fix', () => {
    const { t, check } = checked('cost-0001', 0.05);
    expect(check.actual_usd).toBeCloseTo(t.cost, 2);
    expect(check.status).toBe('over');
    expect(check.delta_usd).toBeGreaterThan(0);
    const model = check.drivers.find((d) => d.id === 'model');
    expect(model?.fix?.id).toBe('model-sonnet');
    expect(model!.usd).toBeGreaterThan(0);
    expect(check.savable_usd).toBeLessThanOrEqual(check.actual_usd);
    const text = renderCheck(check);
    expect(text).toContain('OVER by');
    expect(text).toContain('tally fix model-sonnet');
    expect(headline(check)).toContain('/tally:cost');
    expect(fs.existsSync(path.join(sessionDir('cost-0001'), 'cost-check.json'))).toBe(true);
  });

  it('is on target or under when the estimate says so, and never calls over against an unrelated median', () => {
    expect(checked('cost-0002', 100).check.status).toBe('under');
    const t = parseTranscriptFile(path.join(basicFixture, 'transcript.jsonl'));
    const all = computeCheck('cost-0003', { transcript: t, estimate: { usd: 0.01, low_usd: 0.01, high_usd: 0.01, basis: 'all', confidence: 'low', n: 50, corpus: 50, neighbours: [], computed_at: '' } });
    expect(all.status).toBe('no_estimate');
    expect(renderCheck(all)).toContain('no similar past story yet');
  });

  it('applies a settings fix to the repo, merges with what is there, and undoes byte for byte', () => {
    const { cwd, check } = checked('cost-0004', 0.05);
    const file = path.join(cwd, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = '{\n  "permissions": { "allow": ["Bash(npm test)"] }\n}\n';
    fs.writeFileSync(file, original);
    const r = applyFix(findFix(check, 'model-sonnet')!, { session: 'cost-0004', cwd });
    expect(r.ok).toBe(true);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(after.model).toBe('sonnet');
    expect(after.permissions.allow).toEqual(['Bash(npm test)']);
    undoLast(1);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('--global writes the user settings instead', () => {
    const { cwd, check } = checked('cost-0005', 0.05);
    const r = applyFix(findFix(check, 'model-sonnet')!, { session: 'cost-0005', cwd, global: true });
    expect(r.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(iso.claude, 'settings.json'), 'utf8')).model).toBe('sonnet');
    expect(fs.existsSync(path.join(cwd, '.claude', 'settings.json'))).toBe(false);
  });

  it('a CLAUDE.md fix appends only lines that are not there yet', () => {
    const cwd = tmpDir('tally-md-');
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '# Repo\n- `npm test`\n');
    const fix = { id: 'claude-md', title: 't', what: 'w', apply: { kind: 'claude_md' as const, content: '## Commands\n- `npm test`\n- `npm run lint`\n\n## Files\n- src/a.js\n' } };
    expect(applyFix(fix, { session: 'cost-0006', cwd }).ok).toBe(true);
    const md = fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8');
    expect(md.match(/npm test/g)!.length).toBe(1);
    expect(md).toContain('- `npm run lint`');
    expect(md).toContain('- src/a.js');
    expect(applyFix(fix, { session: 'cost-0006', cwd }).detail).toContain('already has');
  });
});

describe('in the session: status line and the end-of-turn notice', () => {
  function stop(session: string) {
    return spawnSync(process.execPath, [HOOK, 'Stop'], { input: JSON.stringify({ session_id: session, cwd: '/r', last_assistant_message: 'Done.' }), encoding: 'utf8', env: { ...process.env, TALLY_NO_SPAWN: '1' } });
  }
  const est = (usd: number) => ({ usd, low_usd: usd * 0.8, high_usd: usd * 1.3, basis: 'similar', confidence: 'medium', n: 5, corpus: 20, neighbours: [], computed_at: '' });

  it('the status line shows spend against the estimate and records spend for the hook', () => {
    const session = 'live-0001';
    writeJson(path.join(sessionDir(session), 'estimate.json'), est(50));
    const line = renderStatusLine({ session_id: session, cost: { total_cost_usd: 75 } }, false);
    expect(line).toContain('$75.00 / ~$50.00 est (150%)');
    expect(JSON.parse(fs.readFileSync(path.join(sessionDir(session), 'spend.json'), 'utf8')).usd).toBe(75);
  });

  it('tells the user the estimate once, then each threshold crossed once, then the ship result', () => {
    const session = 'live-0002';
    const dir = sessionDir(session);
    writeJson(path.join(dir, 'estimate.json'), est(50));
    writeJson(path.join(dir, 'spend.json'), { usd: 10 });
    const first = JSON.parse(stop(session).stdout) as { systemMessage: string };
    expect(first.systemMessage).toContain('~$50.00');
    expect(first.systemMessage).toContain('5 similar past stories');
    expect(stop(session).stdout.trim()).toBe('');
    writeJson(path.join(dir, 'cost-check.json'), { actual_usd: 75, drivers: [{ title: 'Main model claude-opus-5', usd: 30, fix: { id: 'model-sonnet', apply: { kind: 'settings' } } }] });
    const over = JSON.parse(stop(session).stdout) as { systemMessage: string };
    expect(over.systemMessage).toContain('$75.00');
    expect(over.systemMessage).toContain('+$25.00');
    expect(over.systemMessage).toContain('tally fix model-sonnet');
    expect(stop(session).stdout.trim()).toBe('');
    fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ ts: new Date().toISOString(), type: 'ship', session, data: {} }) + '\n');
    expect((JSON.parse(stop(session).stdout) as { systemMessage: string }).systemMessage).toContain('shipped for $75.00');
  });

  it('says nothing without an estimate, or with only the median of unrelated sessions', () => {
    expect(stop('live-0003').stdout.trim()).toBe('');
    writeJson(path.join(sessionDir('live-0005'), 'estimate.json'), { ...est(0.01), basis: 'all' });
    writeJson(path.join(sessionDir('live-0005'), 'spend.json'), { usd: 5 });
    expect(stop('live-0005').stdout.trim()).toBe('');
  });

  it('`tally cost` and `tally fix --list` work on a session recorded by the hooks', () => {
    const session = 'live-0004';
    const dir = sessionDir(session);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(basicFixture, 'transcript.jsonl'), path.join(dir, 'transcript.jsonl'));
    writeJson(path.join(dir, 'estimate.json'), est(0.05));
    const r = spawnSync(process.execPath, [CLI, 'cost', session], { encoding: 'utf8', env: process.env });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Tally cost check');
    expect(r.stdout).toContain('OVER by');
    const l = spawnSync(process.execPath, [CLI, 'fix', '--list', '--session', session], { encoding: 'utf8', env: process.env });
    expect(l.stdout).toContain('model-sonnet');
  });
});
