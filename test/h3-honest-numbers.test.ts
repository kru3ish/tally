import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isolate, basicFixture } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { buildContext } from '../src/coach/context.js';
import { deadWeight, findDeadWeight, REMOVE_AFTER_UNUSED_SESSIONS } from '../src/coach/rules/dead-weight.js';
import { parseOtlpMetrics, recordOtelPoints, otelCostForSession, startOtelReceiver, otelFile, otelSetupEnv } from '../src/cost/otel.js';
import { otelCrossCheck } from '../src/judge/judge.js';
import { transcriptFormatCheck } from '../src/commands/doctor.js';
import type { HistoryEntry } from '../src/coach/types.js';

let iso: ReturnType<typeof isolate>;
beforeEach(() => {
  iso = isolate();
});
afterEach(() => iso.restore());

const CWD = 'C:\\Users\\dev\\acme-app';
const repo = CWD.replace(/\\/g, '/').toLowerCase();
const session = (i: number, mcp: string[], used: string[], tokens: number): HistoryEntry => ({ ts: `2026-09-${String(i).padStart(2, '0')}T10:00:00Z`, kind: 'session', session: `s${i}`, repo, loaded: { mcp, skills: [], plugins: [] }, used: { mcp: used, skills: [] }, first_turn_tokens: tokens });

describe('H3 dead-weight honesty', () => {
  it('labels the overhead estimated and recommends watch when no session without the item exists', () => {
    const history = [1, 2, 3, 4].map((i) => session(i, ['github', 'postgres'], ['github'], 45000));
    const ctx = buildContext({ session: 'x', cwd: CWD, cfg: loadConfig(), events: [], history });
    const dw = findDeadWeight(ctx);
    const pg = dw.items.find((x) => x.name === 'postgres')!;
    expect(pg.basis).toBe('estimated');
    expect(pg.recommendation).toBe('watch');
    expect(pg.unused_streak).toBe(4);
    const s = deadWeight.evaluate(ctx);
    expect(s[0]!.title).toContain('estimated, watch');
    expect(s[0]!.message).toContain('Estimated');
    expect(s[0]!.message).toContain('Recommendation: watch');
    expect(s[0]!.action.kind).toBe('none');
  });

  it('measures the delta from sessions with and without the item and recommends removal', () => {
    const history = [session(1, ['github'], ['github'], 30000), session(2, ['github'], ['github'], 31000), session(3, ['github', 'postgres'], ['github'], 45000), session(4, ['github', 'postgres'], ['github'], 46000), session(5, ['github', 'postgres'], ['github'], 44000)];
    const ctx = buildContext({ session: 'x', cwd: CWD, cfg: loadConfig(), events: [], history });
    const pg = findDeadWeight(ctx).items.find((x) => x.name === 'postgres')!;
    expect(pg.basis).toBe('measured');
    expect(pg.overhead_tokens).toBe(14500);
    expect(pg.compared).toEqual({ with: 3, without: 2 });
    expect(pg.recommendation).toBe('remove');
    const s = deadWeight.evaluate(ctx);
    expect(s[0]!.message).toContain('Measured: first turns in this repo run 14,500 tokens higher');
    expect(s[0]!.action.kind).toBe('snippet');
  });

  it('recommends removal after 10 unused sessions even without a measurement', () => {
    const history = Array.from({ length: REMOVE_AFTER_UNUSED_SESSIONS + 1 }, (_, i) => session(i + 1, ['github', 'jira'], ['github'], 40000));
    const ctx = buildContext({ session: 'x', cwd: CWD, cfg: loadConfig(), events: [], history });
    const jira = findDeadWeight(ctx).items.find((x) => x.name === 'jira')!;
    expect(jira.basis).toBe('estimated');
    expect(jira.unused_streak).toBe(REMOVE_AFTER_UNUSED_SESSIONS + 1);
    expect(jira.recommendation).toBe('remove');
    const nine = Array.from({ length: 9 }, (_, i) => session(i + 1, ['github', 'jira'], ['github'], 40000));
    expect(findDeadWeight(buildContext({ session: 'x', cwd: CWD, cfg: loadConfig(), events: [], history: nine })).items[0]!.recommendation).toBe('watch');
  });
});

const sample = (sessionId: string, cost: number) => ({
  resourceMetrics: [
    {
      scopeMetrics: [
        {
          metrics: [
            { name: 'claude_code.cost.usage', sum: { aggregationTemporality: 1, dataPoints: [{ asDouble: cost, timeUnixNano: '1757500000000000000', attributes: [{ key: 'session.id', value: { stringValue: sessionId } }, { key: 'model', value: { stringValue: 'claude-opus-5' } }] }] } },
            { name: 'claude_code.token.usage', sum: { dataPoints: [{ asInt: '1200', attributes: [{ key: 'session.id', value: { stringValue: sessionId } }, { key: 'type', value: { stringValue: 'input' } }] }, { asInt: 300, attributes: [{ key: 'session.id', value: { stringValue: sessionId } }, { key: 'type', value: { stringValue: 'output' } }] }] } },
            { name: 'claude_code.lines_of_code.count', sum: { dataPoints: [{ asInt: 5, attributes: [] }] } },
            { name: 'http.client.duration', sum: { dataPoints: [{ asDouble: 1 }] } },
          ],
        },
      ],
    },
  ],
});

describe('H3 OTel cost source', () => {
  it('parses OTLP JSON metrics and sums a session', () => {
    const points = parseOtlpMetrics(sample('sess-1', 0.25));
    expect(points.map((p) => p.name)).toEqual(['claude_code.cost.usage', 'claude_code.token.usage', 'claude_code.token.usage', 'claude_code.lines_of_code.count']);
    expect(points[0]!.ts).toBe('2025-09-10T10:26:40.000Z');
    recordOtelPoints(points);
    recordOtelPoints(parseOtlpMetrics(sample('sess-1', 0.1)));
    recordOtelPoints(parseOtlpMetrics(sample('other', 9)));
    const c = otelCostForSession('sess-1');
    expect(c.available).toBe(true);
    expect(c.total_usd).toBeCloseTo(0.35, 6);
    expect(c.tokens.input).toBe(2400);
    expect(c.tokens.output).toBe(600);
    expect(c.by_model['claude-opus-5']).toBeCloseTo(0.35, 6);
    expect(otelCostForSession('nope').available).toBe(false);
    expect(fs.existsSync(otelFile())).toBe(true);
  });

  it('the loopback receiver accepts OTLP/HTTP JSON and the judge shows the cross-check', async () => {
    const { server, port } = await startOtelReceiver({ port: 0 });
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/metrics`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sample('fx', 1.5)) });
      expect(r.status).toBe(200);
      const bad = await fetch(`http://127.0.0.1:${port}/v1/metrics`, { method: 'POST', body: 'not json' });
      expect(bad.status).toBe(200);
      const env = otelSetupEnv(port);
      expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(`http://127.0.0.1:${port}`);
      expect(env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE).toBe('delta');
    } finally {
      server.close();
    }
    const x = otelCrossCheck('fx', 1.326);
    expect(x?.available).toBe(true);
    expect(x?.total_usd).toBe(1.5);
    expect(x?.delta_usd).toBeCloseTo(0.174, 3);
    expect(otelCrossCheck('unknown-session', 1)).toBeUndefined();
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1';
    expect(otelCrossCheck('unknown-session', 1)?.available).toBe(false);
    delete process.env.CLAUDE_CODE_ENABLE_TELEMETRY;
  });
});

describe('H3 doctor transcript format', () => {
  it('reports unparseable lines and unknown layouts from recent transcripts', () => {
    const proj = path.join(iso.claude, 'projects', 'C--repo');
    fs.mkdirSync(proj, { recursive: true });
    fs.copyFileSync(path.join(basicFixture, 'transcript.jsonl'), path.join(proj, 'good.jsonl'));
    const ok = transcriptFormatCheck('C:\\repo');
    expect(ok.ok).toBe(true);
    expect(ok.detail).toContain('0/');
    fs.writeFileSync(path.join(proj, 'bad.jsonl'), fs.readFileSync(path.join(basicFixture, 'transcript.jsonl'), 'utf8').replace(/"version":"2\.1\.268"/g, '"version":"9.0.0"') + '{broken\n');
    const warn = transcriptFormatCheck('C:\\repo');
    expect(warn.ok).toBe('warn');
    expect(warn.detail).toContain('not a verified layout');
    expect(warn.detail).toContain('1/');
  });
});
