import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isolate, basicFixture } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { StubLlm, tallySpendFile } from '../src/llm/client.js';
import { classifyRef, fetchTask, type FetchDeps } from '../src/task/fetchers.js';
import { intake, loadTask, computeBudget, computeEstimate, TaskSchema, renderTask } from '../src/task/intake.js';

let iso: ReturnType<typeof isolate>;
beforeEach(() => {
  iso = isolate();
});
afterEach(() => iso.restore());

function deps(over: Partial<FetchDeps> = {}): FetchDeps {
  return {
    exec: () => ({ ok: false, stdout: '', stderr: 'gh: not found' }),
    fetch: async () => ({ ok: false, status: 500, text: async () => '' }),
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    exists: (p) => fs.existsSync(p),
    ...over,
  };
}

const intakeStub = (score = 7) => ({
  intake: () => ({
    title: 'Rate limit the login endpoint',
    criteria: [
      { text: 'Login returns 429 after 5 failed attempts per IP within 15 minutes', source: 'explicit' },
      { text: 'A test covers the 429 path', source: 'explicit' },
      { text: 'README documents the limit', source: 'explicit' },
      { text: 'Existing login tests still pass', source: 'inferred' },
    ],
    spec_quality: { score, missing: score < 5 ? ['what counts as a failed attempt', 'reset behaviour'] : [], questions: score < 5 ? ['Does a successful login reset the counter?'] : [] },
    estimate_hours: 3,
    rationale: 'small middleware plus test',
  }),
});

describe('fetchers', () => {
  it('classifies refs', () => {
    expect(classifyRef('https://github.com/acme/app/issues/42', 'C:/x', deps()).kind).toBe('github');
    expect(classifyRef('https://github.com/acme/app/pull/7', 'C:/x', deps())).toMatchObject({ kind: 'github', is_pr: true, number: 7 });
    expect(classifyRef('https://acme.atlassian.net/browse/APP-42', 'C:/x', deps())).toMatchObject({ kind: 'jira', key: 'APP-42' });
    expect(classifyRef('APP-42', 'C:/x', deps())).toMatchObject({ kind: 'jira', key: 'APP-42' });
    expect(classifyRef('https://linear.app/acme/issue/ENG-123/rate-limit', 'C:/x', deps())).toMatchObject({ kind: 'linear', key: 'ENG-123' });
    expect(classifyRef('task.md', basicFixture, deps()).kind).toBe('file');
    expect(classifyRef('missing.md', basicFixture, deps()).kind).toBe('text');
    expect(classifyRef('add a login rate limit', 'C:/x', deps()).kind).toBe('text');
  });

  it('fetches github issues through gh and reads story point labels', async () => {
    const d = deps({ exec: (bin, args) => ({ ok: bin === 'gh' && args[0] === 'issue', stdout: JSON.stringify({ title: 'Rate limit login', body: 'Block after 5 attempts.', labels: [{ name: 'sp:3' }], state: 'OPEN' }), stderr: '' }) });
    const t = await fetchTask('https://github.com/acme/app/issues/42', { cwd: 'C:/x', cfg: loadConfig(), deps: d });
    expect(t.title).toBe('Rate limit login');
    expect(t.story_points).toBe(3);
    expect(t.fetch_error).toBeUndefined();
  });

  it('uses the GitHub REST API when gh is missing', async () => {
    const calls: string[] = [];
    const d = deps({
      fetch: async (url) => {
        calls.push(String(url));
        return { ok: true, status: 200, text: async () => JSON.stringify({ title: 'Rate limit login', body: 'Return 429 after 5 tries.', labels: [{ name: 'bug' }, { name: 'sp-3' }], state: 'open' }) };
      },
    });
    const t = await fetchTask('https://github.com/acme/app/issues/42', { cwd: 'C:/x', cfg: loadConfig(), deps: d });
    expect(calls[0]).toBe('https://api.github.com/repos/acme/app/issues/42');
    expect(t.fetch_error).toBeUndefined();
    expect(t.title).toBe('Rate limit login');
    expect(t.labels).toEqual(['bug', 'sp-3']);
    expect(t.story_points).toBe(3);
  });

  it('falls back to prompt text when gh fails', async () => {
    const t = await fetchTask('https://github.com/acme/app/issues/42', { cwd: 'C:/x', cfg: loadConfig(), deps: deps(), promptText: 'Fix https://github.com/acme/app/issues/42 the login limiter' });
    expect(t.fetch_error).toContain('gh issue view failed');
    expect(t.body).toContain('login limiter');
    expect(t.source.kind).toBe('github');
  });

  it('fetches jira with basic auth and ADF description', async () => {
    const cfg = loadConfig();
    cfg.jira = { base_url: 'https://acme.atlassian.net', email: 'me@acme.com', api_token: 'tok' };
    let seenAuth = '';
    const d = deps({
      fetch: async (url, init) => {
        seenAuth = init?.headers?.Authorization ?? '';
        expect(url).toBe('https://acme.atlassian.net/rest/api/3/issue/APP-42');
        return { ok: true, status: 200, text: async () => JSON.stringify({ fields: { summary: 'Limit login', description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Block after 5.' }] }] }, labels: ['auth'], customfield_10016: 5, status: { name: 'To Do' } } }) };
      },
    });
    const t = await fetchTask('APP-42', { cwd: 'C:/x', cfg, deps: d });
    expect(seenAuth.startsWith('Basic ')).toBe(true);
    expect(t.title).toBe('Limit login');
    expect(t.body.trim()).toBe('Block after 5.');
    expect(t.story_points).toBe(5);
    expect(t.source.url).toBe('https://acme.atlassian.net/browse/APP-42');
  });

  it('fetches linear via graphql', async () => {
    const cfg = loadConfig();
    cfg.linear = { api_key: 'lin_api_x' };
    const d = deps({ fetch: async (url, init) => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: { issue: { title: 'Limit', description: 'desc', estimate: 2, url: 'https://linear.app/acme/issue/ENG-1', state: { name: 'Todo' }, labels: { nodes: [{ name: 'backend' }] } } } }) }) });
    const t = await fetchTask('https://linear.app/acme/issue/ENG-1/limit', { cwd: 'C:/x', cfg, deps: d });
    expect(t.title).toBe('Limit');
    expect(t.story_points).toBe(2);
    expect(t.labels).toEqual(['backend']);
  });

  it('reads local markdown', async () => {
    const t = await fetchTask('task.md', { cwd: basicFixture, cfg: loadConfig(), deps: deps() });
    expect(t.source.kind).toBe('file');
    expect(t.title).toBe('Rate limit the login endpoint');
    expect(t.body).toContain('Add tests');
  });
});

describe('intake', () => {
  it('freezes criteria, scores the spec, estimates, and budgets', async () => {
    const llm = new StubLlm(intakeStub(7));
    const { task, created } = await intake({ session: 's1', cwd: basicFixture, ref: 'task.md', cfg: loadConfig(), llm, deps: deps() });
    expect(created).toBe(true);
    expect(task.frozen).toBe(true);
    expect(task.criteria.length).toBe(4);
    expect(task.criteria[0]!.id).toBe('c1');
    expect(task.spec_quality.score).toBe(7);
    expect(task.needs_clarification).toBe(false);
    expect(task.estimate).toEqual({ hours: 3, basis: 'llm' });
    expect(task.budget_usd).toBe(computeBudget(3, 75));
    expect(task.budget_usd).toBe(56.25);
    expect(TaskSchema.safeParse(JSON.parse(fs.readFileSync(path.join(iso.home, 'sessions', 's1', 'task.json'), 'utf8'))).success).toBe(true);
    expect(llm.calls[0]!.kind).toBe('intake');
    expect(llm.calls[0]!.prompt).toContain('Add tests');
    expect(fs.readFileSync(tallySpendFile(), 'utf8')).toContain('"intake"');
  });

  it('flags low spec quality and lists questions', async () => {
    const llm = new StubLlm(intakeStub(3));
    const { task } = await intake({ session: 's2', cwd: 'C:/x', text: 'make login better', cfg: loadConfig(), llm, deps: deps() });
    expect(task.needs_clarification).toBe(true);
    expect(task.spec_quality.questions.length).toBe(1);
    const rendered = renderTask(task);
    expect(rendered).toContain('Clarify the ticket first');
    expect(rendered).toContain('Does a successful login reset the counter?');
    expect(task.source.kind).toBe('text');
  });

  it('does not move the goalposts once frozen', async () => {
    const llm = new StubLlm(intakeStub(7));
    await intake({ session: 's3', cwd: 'C:/x', text: 'first', cfg: loadConfig(), llm, deps: deps() });
    const second = await intake({ session: 's3', cwd: 'C:/x', text: 'second, different', cfg: loadConfig(), llm, deps: deps() });
    expect(second.created).toBe(false);
    expect(llm.calls.length).toBe(1);
    expect(loadTask('s3')!.body_excerpt).toBe('first');
    const forced = await intake({ session: 's3', cwd: 'C:/x', text: 'second, different', cfg: loadConfig(), llm, deps: deps(), force: true });
    expect(forced.created).toBe(true);
  });

  it('prefers story points for the estimate', async () => {
    const est = computeEstimate({ source: { kind: 'github', ref: 'x' }, title: 't', body: '', labels: [], story_points: 3 }, 10);
    expect(est).toEqual({ hours: 12, basis: 'story_points', story_points: 3 });
    expect(computeBudget(0, 75)).toBe(2);
  });
});
