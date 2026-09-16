import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isolate, basicFixture } from './helpers.js';
import { canonicalModel, costOf, loadPricing, resetPricingCache, priceFor } from '../src/cost/pricing.js';
import { redact, redactDeep } from '../src/redact.js';
import { appendEvent, readEvents, EventTail, eventsFile, listSessions } from '../src/store/events.js';
import { loadConfig, saveConfig } from '../src/config.js';
import { parseTranscriptFile, isShipCommand, isTestCommand } from '../src/transcript/parse.js';
import { computeWaste, findFailedLoops, findRepeatedReads } from '../src/cost/waste.js';
import { attribute, markTouched } from '../src/cost/attribution.js';

let iso: ReturnType<typeof isolate>;
beforeEach(() => {
  iso = isolate();
  resetPricingCache();
});
afterEach(() => iso.restore());

describe('pricing', () => {
  it('canonicalizes model names including 1m and alias forms', () => {
    expect(canonicalModel('claude-fable-5-1[1m]')).toBe('claude-fable-5-1');
    expect(canonicalModel('claude-opus-5')).toBe('claude-opus-5');
    expect(canonicalModel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(canonicalModel('opus')).toBe('claude-opus-5');
    expect(canonicalModel('something-unknown')).toBe(loadPricing().fallback);
  });
  it('computes cost with cache tiers', () => {
    const p = priceFor('claude-opus-5');
    const usd = costOf({ input: 1_000_000, output: 0, cache_write: 0, cache_read: 0 }, 'claude-opus-5');
    expect(usd).toBeCloseTo(p.input, 6);
    const cached = costOf({ input: 0, output: 0, cache_write: 1_000_000, cache_write_1h: 1_000_000, cache_read: 0 }, 'claude-opus-5');
    expect(cached).toBeCloseTo(p.cache_write_1h, 6);
    const c5 = costOf({ input: 0, output: 0, cache_write: 1_000_000, cache_write_1h: 0, cache_read: 0 }, 'claude-opus-5');
    expect(c5).toBeCloseTo(p.cache_write_5m, 6);
  });
  it('has a last_verified date', () => {
    expect(loadPricing().last_verified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('redact', () => {
  it('masks common secrets', () => {
    const s = 'key sk-ant-api03-abcdefghijklmnop token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12 AKIAIOSFODNN7EXAMPLE Authorization: Bearer abcdefghijklmnopqrstuvwxyz';
    const r = redact(s);
    expect(r).not.toContain('abcdefghijklmnop');
    expect(r).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12');
    expect(r).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(r).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(redact('password=hunter2secret')).toBe('password=***');
    expect(redact('https://user:p4ssw0rd@host/repo')).toBe('https://user:***@host/repo');
  });
  it('redacts nested objects', () => {
    const r = redactDeep({ a: ['x', { token: 'api_key=abcdefgh' }] });
    expect(JSON.stringify(r)).not.toContain('abcdefgh');
  });
  it('leaves normal text alone', () => {
    expect(redact('npm test && git push origin main')).toBe('npm test && git push origin main');
  });
});

describe('event store', () => {
  it('appends and reads and tails', () => {
    appendEvent({ ts: 't1', type: 'prompt', session: 's1', data: { prompt: 'hi' } });
    appendEvent({ ts: 't2', type: 'stop', session: 's1', data: {} });
    expect(readEvents('s1').map((e) => e.type)).toEqual(['prompt', 'stop']);
    const tail = new EventTail(eventsFile('s1'));
    expect(tail.poll().length).toBe(2);
    expect(tail.poll().length).toBe(0);
    appendEvent({ ts: 't3', type: 'ship', session: 's1', data: {} });
    expect(tail.poll().map((e) => e.type)).toEqual(['ship']);
    expect(listSessions()).toEqual(['s1']);
    expect(fs.existsSync(path.join(iso.home, 'sessions', 's1', 'events.jsonl'))).toBe(true);
  });
  it('survives a torn line', () => {
    appendEvent({ ts: 't1', type: 'prompt', session: 's2', data: {} });
    fs.appendFileSync(eventsFile('s2'), '{"broken":');
    expect(readEvents('s2').length).toBe(1);
  });
});

describe('config', () => {
  it('has defaults and persists', () => {
    const c = loadConfig();
    expect(c.hourly_rate).toBe(75);
    expect(c.auto_apply).toBe('ask');
    saveConfig({ hourly_rate: 120, coach: { max_per_session: 4 } });
    const c2 = loadConfig();
    expect(c2.hourly_rate).toBe(120);
    expect(c2.coach.max_per_session).toBe(4);
    expect(c2.coach.min_interval_s).toBe(180);
  });
});

describe('transcript parser', () => {
  const file = path.join(basicFixture, 'transcript.jsonl');
  it('dedupes streamed message lines and totals usage', () => {
    const t = parseTranscriptFile(file);
    expect(t.sessionId).toBe('fx-basic-0001-4c0d-8e1a-000000000001');
    const ids = new Set(t.messages.map((m) => m.id));
    expect(ids.size).toBe(t.messages.length);
    expect(t.cost).toBeGreaterThan(0.5);
    expect(t.usage.output).toBeGreaterThan(3000);
    expect(t.models).toContain('claude-opus-5');
    expect(t.models).toContain('claude-haiku-4-5');
  });
  it('attributes subagent work separately', () => {
    const t = parseTranscriptFile(file);
    expect(Object.keys(t.byAgent)).toContain('agent-explore-01');
    expect(t.byAgent['agent-explore-01']!.messages).toBe(3);
    expect(t.byAgent['agent-explore-01']!.cost).toBeGreaterThan(0);
    expect(t.byAgent.main!.cost).toBeGreaterThan(t.byAgent['agent-explore-01']!.cost);
  });
  it('tracks prompts, turns, compactions, phases, skills, and mcp', () => {
    const t = parseTranscriptFile(file);
    expect(t.prompts.length).toBe(2);
    expect(t.compactions.length).toBe(1);
    expect(t.messages.some((m) => m.afterCompaction)).toBe(true);
    expect(t.byPhase.explore.messages).toBeGreaterThan(0);
    expect(t.byPhase.build.messages).toBeGreaterThan(0);
    expect(t.byPhase.verify.messages).toBeGreaterThan(0);
    expect(t.byPhase.ship.messages).toBeGreaterThan(0);
    expect(t.skills.map((s) => s.name)).toEqual(['superpowers:test-driven-development']);
    expect(t.mcpCalls.filter((m) => m.server === 'jira' && m.isError).length).toBe(3);
    expect(t.mcpCalls.filter((m) => m.server === 'github').length).toBe(1);
    expect(t.firstTurnContextTokens).toBe(28003);
    expect(t.contextTokensNow).toBeGreaterThan(0);
    expect(t.finalAssistantText).toContain('PR #57');
  });
  it('attaches tool results with error flags', () => {
    const t = parseTranscriptFile(file);
    const tests = t.toolCalls.filter((c) => c.name === 'Bash' && String(c.input.command) === 'npm test');
    expect(tests.length).toBe(4);
    expect(tests.filter((c) => c.result?.isError).length).toBe(3);
    expect(tests[3]!.result?.isError).toBe(false);
  });
  it('classifies commands', () => {
    expect(isShipCommand('git push -u origin x')).toBe(true);
    expect(isShipCommand('gh pr create --title x')).toBe(true);
    expect(isShipCommand('git status')).toBe(false);
    expect(isTestCommand('npm test')).toBe(true);
    expect(isTestCommand('pytest -q')).toBe(true);
    expect(isTestCommand('ls')).toBe(false);
  });
});

describe('waste + attribution', () => {
  const file = path.join(basicFixture, 'transcript.jsonl');
  it('finds failed loops and repeated reads with dollar amounts', () => {
    const t = parseTranscriptFile(file);
    const loops = findFailedLoops(t.toolCalls);
    expect(loops[0]!.command).toBe('npm test');
    expect(loops[0]!.repeats).toBe(3);
    const reads = findRepeatedReads(t.toolCalls);
    expect(reads[0]!.file.endsWith('src/routes/login.ts')).toBe(true);
    expect(reads[0]!.reads).toBe(3);
    const w = computeWaste(t, { baselineTokens: 15000 });
    expect(w.failed_loops[0]!.usd).toBeGreaterThan(0);
    expect(w.repeated_reads[0]!.usd).toBeGreaterThan(0);
    expect(w.dead_weight.overhead_tokens).toBe(13003);
    expect(w.compaction_churn.compactions).toBe(1);
    expect(w.compaction_churn.usd).toBeGreaterThan(0);
    expect(w.total_usd).toBeGreaterThan(0);
    expect(w.total_usd).toBeLessThan(t.cost);
  });
  it('attributes skills and mcp with touched flag', () => {
    const t = parseTranscriptFile(file);
    const rows = attribute(t);
    const jira = rows.find((r) => r.name === 'jira:get_issue')!;
    expect(jira.invocations).toBe(3);
    expect(jira.errors).toBe(3);
    const skill = rows.find((r) => r.kind === 'skill')!;
    expect(skill.tokens).toBeGreaterThan(0);
    const marked = markTouched(rows, t, ['src/routes/login.ts']);
    expect(marked.find((r) => r.kind === 'skill')!.touched_met_criteria).toBe(true);
  });
});
