import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolate, root, basicFixture, tmpDir } from './helpers.js';
import { readLedger, recordStory, entryFromCheck, ledgerFile, type LedgerEntry } from '../src/estimate/ledger.js';
import { buildCorpus, estimateFromCorpus, type CorpusDoc } from '../src/estimate/estimate.js';
import { computeCheck } from '../src/estimate/variance.js';
import { parseTranscriptFile } from '../src/transcript/parse.js';
import { otlpTarget, storyMetrics, exportStory, claudeSettingsEnv, repoSetsTallyOtel } from '../src/telemetry/otlp.js';
import { renderDashboard } from '../src/estimate/dashboard.js';
import { recordFinishedStory } from '../src/estimate/story.js';
import { canOpenBrowser } from '../src/estimate/open.js';
import { sessionDir, writeJson } from '../src/paths.js';

const CLI = path.join(root, 'dist', 'cli.js');
let iso: ReturnType<typeof isolate>;
beforeEach(() => {
  iso = isolate();
});
afterEach(() => iso.restore());

function repo(): string {
  const cwd = tmpDir('tally-team-');
  spawnSync('git', ['init', '-q'], { cwd });
  spawnSync('git', ['config', 'user.name', 'Ada'], { cwd });
  return cwd;
}

function entry(session: string, story: string, actual: number, extra: Partial<LedgerEntry> = {}): LedgerEntry {
  return { v: 1, ts: new Date().toISOString(), session, story, agent: 'claude-code', model: 'claude-sonnet-5-5', actual_usd: actual, status: 'no_estimate', savable_usd: 0, drivers: [], ...extra };
}

describe('team ledger in the repo', () => {
  it('records a story with the git author, replaces a re-recorded session, and survives junk lines', () => {
    const cwd = repo();
    const f = recordStory(cwd, entry('s1', 'Add slugify', 1.2))!;
    expect(f).toBe(ledgerFile(cwd));
    recordStory(path.join(cwd), entry('s2', 'Add truncate', 0.8));
    recordStory(cwd, entry('s1', 'Add slugify', 1.5));
    fs.appendFileSync(f, '<<<<<<< HEAD\nnot json\n');
    const l = readLedger(cwd);
    expect(l.map((e) => [e.session, e.actual_usd])).toEqual([
      ['s2', 0.8],
      ['s1', 1.5],
    ]);
    expect(l[0]!.author).toBe('Ada');
  });

  it('teammates’ stories from the ledger feed the estimate on a machine that has never seen them', () => {
    const cwd = repo();
    for (const [i, s] of ['rate limit the login endpoint', 'add rate limiting to login', 'login rate limit with 429'].entries()) recordStory(cwd, entry(`t${i}`, s, 40 + i * 10));
    const corpus = buildCorpus({ cwd });
    expect(corpus.filter((d) => d.team)).toHaveLength(3);
    const e = estimateFromCorpus('Rate limit login', corpus, { cwd });
    expect(e.basis).toBe('similar');
    expect(e.usd).toBeGreaterThanOrEqual(40);
  });

  it('falls back to story points × the cost per point when nothing is similar', () => {
    const docs: CorpusDoc[] = [1, 2, 3, 5].map((p, i) => ({ session: `p${i}`, text: `unrelated thing ${i} alpha${i}`, cost_usd: p * 10, models: [], story_points: p }));
    const e = estimateFromCorpus('brand new kind of work', docs, { storyPoints: 3 });
    expect(e.basis).toBe('points');
    expect(e.usd).toBe(30);
  });
});

describe('OpenTelemetry story metrics', () => {
  it('finds the endpoint the way OTel SDKs do, and never guesses at a gRPC-only collector', () => {
    expect(otlpTarget({})).toBeNull();
    expect(otlpTarget({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://col:4318/' })!.url).toBe('http://col:4318/v1/metrics');
    expect(otlpTarget({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://col:4318/custom' })!.url).toBe('http://col:4318/custom');
    expect(otlpTarget({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://col:4317', OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' })).toBeNull();
    expect(otlpTarget({ TALLY_OTEL_ENDPOINT: 'http://x:4318', OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' })!.url).toBe('http://x:4318/v1/metrics');
    expect(otlpTarget({ TALLY_OTEL_ENDPOINT: 'http://x:4318', TALLY_OTEL_HEADERS: 'k=v', TALLY_OTEL_RESOURCE_ATTRIBUTES: 'team=core' })).toMatchObject({ headers: { k: 'v' }, resource: 'team=core' });
    expect(otlpTarget({}, undefined, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://org:4318', OTEL_RESOURCE_ATTRIBUTES: 'dept=eng' })).toMatchObject({ url: 'http://org:4318/v1/metrics', resource: 'dept=eng' });
    expect(otlpTarget({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c', OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer%20abc,x-team=core' })!.headers).toMatchObject({ Authorization: 'Bearer abc', 'x-team': 'core' });
  });

  it('reads OTEL_* from user and managed settings files, because Claude Code strips them from hook environments', () => {
    const d = tmpDir('tally-otelset-');
    const user = path.join(d, 'user.json');
    const managed = path.join(d, 'managed.json');
    fs.writeFileSync(user, JSON.stringify({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://mine:4318', OTHER: 'x' } }));
    fs.writeFileSync(managed, JSON.stringify({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://org:4318' } }));
    expect(claudeSettingsEnv([user, managed, path.join(d, 'missing.json')])).toEqual({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://org:4318' });
  });

  it('a repository cannot redirect the metrics: TALLY_OTEL_* from its own settings is ignored', () => {
    const cwd = repo();
    fs.mkdirSync(path.join(cwd, '.claude'));
    fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({ env: { TALLY_OTEL_ENDPOINT: 'http://evil:4318' } }));
    expect(repoSetsTallyOtel(cwd)).toBe(true);
    expect(otlpTarget({ TALLY_OTEL_ENDPOINT: 'http://evil:4318' }, undefined, {}, { repoSetsTally: true })).toBeNull();
    expect(otlpTarget({ TALLY_OTEL_ENDPOINT: 'http://evil:4318' }, undefined, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://org:4318' }, { repoSetsTally: true })!.url).toBe('http://org:4318/v1/metrics');
  });

  it('sends one gauge per figure with the story attributes and no title', async () => {
    const e = entry('s9', 'Secret project name', 75, { key: 'PROJ-12', estimate_usd: 50, delta_usd: 25, status: 'over', savable_usd: 30, author: 'Ada', drivers: [{ id: 'model', usd: 30, fix: 'model-sonnet' }] });
    const body = storyMetrics(e, { repo: 'app', version: '0.7.0', resource: 'team=core' });
    const json = JSON.stringify(body);
    expect(json).not.toContain('Secret project name');
    const metrics = (body as { resourceMetrics: Array<{ resource: { attributes: Array<{ key: string }> }; scopeMetrics: Array<{ metrics: Array<{ name: string; gauge: { dataPoints: Array<{ asDouble: number }> } }> }> }> }).resourceMetrics[0]!;
    expect(metrics.resource.attributes.map((a) => a.key)).toEqual(['service.name', 'service.version', 'team']);
    const byName = Object.fromEntries(metrics.scopeMetrics[0]!.metrics.map((m) => [m.name, m.gauge.dataPoints[0]!.asDouble]));
    expect(byName).toMatchObject({ 'tally.story.cost': 75, 'tally.story.estimate': 50, 'tally.story.overage': 25, 'tally.story.avoidable': 30, 'tally.story.driver.cost': 30 });
    expect(json).toContain('PROJ-12');

    let received = '';
    let headers: http.IncomingHttpHeaders = {};
    const server = http.createServer((req, res) => {
      headers = req.headers;
      req.on('data', (c) => (received += c));
      req.on('end', () => res.writeHead(200).end('{}'));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const r = await exportStory(e, { repo: 'app', version: '0.7.0', target: otlpTarget({ OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`, OTEL_EXPORTER_OTLP_HEADERS: 'x-key=1' })! });
    server.close();
    expect(r.ok).toBe(true);
    expect(headers['x-key']).toBe('1');
    expect(JSON.parse(received).resourceMetrics[0].scopeMetrics[0].metrics.length).toBe(5);
  });

  it('a collector that is down fails quietly within the timeout', async () => {
    const r = await exportStory(entry('s1', 'x', 1), { repo: 'app', version: '0', target: { url: 'http://127.0.0.1:9/v1/metrics', headers: {}, source: 't' }, timeoutMs: 1500 });
    expect(r.ok).toBe(false);
  });
});

describe('dashboard', () => {
  it('renders the current story, the team history, drivers, people and models, escaped, with no external resources', () => {
    const entries = [
      entry('a', 'Add <b>slugify</b>', 1, { key: 'STR-1', estimate_usd: 0.8, estimate_low_usd: 0.5, estimate_high_usd: 1.1, estimate_basis: 'similar', delta_usd: 0.2, status: 'on_target', author: 'Ada', drivers: [{ id: 'model', usd: 0.4, fix: 'model-sonnet' }] }),
      entry('b', 'Markdown converter', 9, { estimate_usd: 4, estimate_low_usd: 3, estimate_high_usd: 5, estimate_basis: 'similar', delta_usd: 5, status: 'over', author: 'Lin', model: 'claude-opus-5-5', savable_usd: 4, drivers: [{ id: 'long-context', usd: 3, fix: 'split-story' }] }),
    ];
    const t = parseTranscriptFile(path.join(basicFixture, 'transcript.jsonl'));
    const current = computeCheck('dash-1', { transcript: t, estimate: { usd: 0.05, low_usd: 0.04, high_usd: 0.06, basis: 'similar', confidence: 'medium', n: 3, corpus: 9, neighbours: [], computed_at: '' } });
    const html = renderDashboard({ repo: 'app', entries, current, now: new Date('2026-10-18T12:00:00Z') });
    expect(html).toContain('This story');
    expect(html).toContain('tally fix model-sonnet');
    expect(html).toContain('Add &lt;b&gt;slugify&lt;/b&gt;');
    expect(html).not.toContain('<b>slugify</b>');
    expect(html).toContain('Next time');
    expect(html).toContain('data-copy="tally fix model-sonnet"');
    expect(html).toContain('Team');
    expect(html).toContain('Lin');
    /* the story title may name a URL; nothing is loaded from one, and the only script is the inline copy button */
    expect(html).not.toMatch(/<link|<img|src=|url\(/);
    expect(html.match(/<script/g)!.length).toBe(1);
  });

  it('never opens a browser under CI or in tests', () => {
    expect(canOpenBrowser({ CI: 'true' })).toBe(false);
    expect(canOpenBrowser({ VITEST: '1' })).toBe(false);
  });
});

describe('a finished story end to end', () => {
  it('session end writes the ledger line in the repo and sends the metrics to the collector', async () => {
    const cwd = repo();
    const session = 'story-0001';
    const dir = sessionDir(session);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(basicFixture, 'transcript.jsonl'), path.join(dir, 'transcript.jsonl'));
    fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ ts: new Date().toISOString(), type: 'session_start', session, cwd, data: { agent: 'claude-code' } }) + '\n');
    writeJson(path.join(dir, 'estimate.json'), { usd: 0.05, low_usd: 0.04, high_usd: 0.06, basis: 'similar', confidence: 'medium', n: 3, corpus: 9, neighbours: [], computed_at: '' });
    let posted = 0;
    const server = http.createServer((req, res) => {
      posted += 1;
      req.resume();
      req.on('end', () => res.writeHead(200).end());
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const prev = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const r = await recordFinishedStory(session, cwd, { open: false });
      expect(r.ledger).toBe(ledgerFile(cwd));
      expect(r.otel).toContain('sent to');
      expect(posted).toBe(1);
      const [e] = readLedger(cwd);
      expect(e!.status).toBe('over');
      expect(e!.author).toBe('Ada');
      expect(fs.existsSync(r.dashboard!)).toBe(true);
    } finally {
      server.close();
      if (prev === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = prev;
    }
  });

  it('`tally dashboard --no-open` writes the page from the ledger', () => {
    const cwd = repo();
    recordStory(cwd, entry('x1', 'Add slugify', 1));
    const r = spawnSync(process.execPath, [CLI, 'dashboard', '--no-open'], { cwd, encoding: 'utf8', env: process.env });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1 story in the team ledger');
    const file = /Wrote (\S+\.html)/.exec(r.stdout)![1]!;
    expect(fs.readFileSync(file, 'utf8')).toContain('Add slugify');
  });
});
