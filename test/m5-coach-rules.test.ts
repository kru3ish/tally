import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isolate, basicFixture, tmpDir } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { readEventsFile, type TallyEvent } from '../src/store/events.js';
import { parseTranscriptFile } from '../src/transcript/parse.js';
import { buildContext } from '../src/coach/context.js';
import { CoachEngine, loadState, isMuted } from '../src/coach/engine.js';
import { RULES, loopDetect, reread, contextPressure, claudeMd, mcpOpportunity, deadWeight, mcpErrors, permissionFriction, burnRate, taskQuality, historyLesson } from '../src/coach/rules/index.js';
import { repeatedInstructions } from '../src/coach/rules/claude-md.js';
import type { HistoryEntry, RuleContext } from '../src/coach/types.js';
import type { Task } from '../src/task/intake.js';

let iso: ReturnType<typeof isolate>;
beforeEach(() => {
  iso = isolate();
});
afterEach(() => iso.restore());

const CWD = 'C:\\Users\\dev\\acme-app';
const fixtureEvents = () => readEventsFile(path.join(basicFixture, 'events.jsonl'));
const transcript = () => parseTranscriptFile(path.join(basicFixture, 'transcript.jsonl'));

function ctx(over: Partial<RuleContext> = {}): RuleContext {
  const base = buildContext({ session: 'fx', cwd: CWD, cfg: loadConfig(), events: fixtureEvents(), transcript: transcript(), history: [] });
  return { ...base, ...over };
}

function ev(type: TallyEvent['type'], data: Record<string, unknown>, ts = '2026-09-10T14:00:00.000Z'): TallyEvent {
  return { ts, type, session: 'fx', cwd: CWD, data };
}

const task = (over: Partial<Task> = {}): Task => ({
  session: 'fx',
  cwd: CWD,
  created_at: 'x',
  frozen: true,
  source: { kind: 'text', ref: 'x' },
  title: 'Rate limit login',
  body_excerpt: '',
  labels: [],
  criteria: [{ id: 'c1', text: 'a', source: 'explicit' }],
  spec_quality: { score: 7, missing: [], questions: [] },
  needs_clarification: false,
  estimate: { hours: 2, basis: 'llm' },
  budget_usd: 10,
  hourly_rate: 75,
  tally_cost_usd: 0,
  model: 'stub',
  ...over,
});

describe('rules', () => {
  it('has all 11 rules plus the consent prompt', () => {
    expect(RULES.map((r) => r.id)).toEqual(['loop-detect', 'reread', 'context-pressure', 'claude-md', 'mcp-opportunity', 'dead-weight', 'mcp-errors', 'permission-friction', 'burn-rate', 'task-quality', 'history-lesson', 'verification-consent', 'task-confirm']);
  });

  it('loop-detect: fires as critical on 3 identical failing commands and on repeated failing edits', () => {
    const s = loopDetect.evaluate(ctx());
    expect(s.length).toBe(1);
    expect(s[0]!.severity).toBe('critical');
    expect(s[0]!.message).toContain('npm test');
    expect(s[0]!.action.kind).toBe('inject');
    expect(s[0]!.usd_saved).toBeGreaterThan(0);
    const edits = [1, 2, 3].map(() => ev('post_tool', { tool_name: 'Edit', tool_input: { file_path: 'C:/x/a.ts', old_string: 'foo' }, is_error: true }));
    const s2 = loopDetect.evaluate(ctx({ events: edits }));
    expect(s2[0]!.title).toContain('Same edit failed 3');
    expect(loopDetect.evaluate(ctx({ events: edits.slice(0, 2) })).length).toBe(0);
  });

  it('reread: fires when the same file is read 3 times', () => {
    const s = reread.evaluate(ctx());
    expect(s.length).toBe(1);
    expect(s[0]!.title).toContain('login.ts read 3');
    expect(s[0]!.severity).toBe('warn');
    const two = [1, 2].map(() => ev('post_tool', { tool_name: 'Read', tool_input: { file_path: 'a' }, response_chars: 100 }));
    expect(reread.evaluate(ctx({ events: two })).length).toBe(0);
  });

  it('context-pressure: warns at 70%, critical at 85%, and drafts HANDOFF.md', () => {
    expect(contextPressure.evaluate(ctx({ contextTokensNow: 100000, contextWindow: 200000 })).length).toBe(0);
    const warn = contextPressure.evaluate(ctx({ contextTokensNow: 150000, contextWindow: 200000, task: task() }));
    expect(warn[0]!.severity).toBe('warn');
    expect(warn[0]!.action.kind).toBe('write_md');
    const a = warn[0]!.action as { content: string; file: string };
    expect(a.file.endsWith('HANDOFF.md')).toBe(true);
    expect(a.content).toContain('## Goal');
    expect(a.content).toContain('Rate limit login');
    expect(a.content).toContain('## Next steps');
    expect(warn[0]!.message).toContain('/compact');
    const crit = contextPressure.evaluate(ctx({ contextTokensNow: 175000, contextWindow: 200000 }));
    expect(crit[0]!.severity).toBe('critical');
    expect(crit[0]!.key).not.toBe(warn[0]!.key);
  });

  it('claude-md: detects repeated instructions and a missing CLAUDE.md', () => {
    const rep = repeatedInstructions(['Always run the tests before pushing. Then fix things.', 'ok now always run the tests before pushing'], []);
    expect(rep[0]!.count).toBe(2);
    const events = [ev('prompt', { prompt: 'Always use bun instead of npm. Add the feature.' }), ev('prompt', { prompt: 'Remember: always use bun instead of npm!' }), ...fixtureEvents().filter((e) => e.type === 'post_tool')];
    const s = claudeMd.evaluate(ctx({ events, claudeMd: null }));
    const repeated = s.find((x) => x.key.startsWith('repeated:'))!;
    expect(repeated.message).toContain('/insights');
    expect(repeated.action.kind).toBe('write_md');
    expect((repeated.action as { mode: string }).mode).toBe('append');
    const missing = s.find((x) => x.key === 'missing-claude-md')!;
    expect(missing).toBeTruthy();
    expect((missing.action as { mode: string }).mode).toBe('create');
    const none = claudeMd.evaluate(ctx({ events, claudeMd: '# repo\n- Always use bun instead of npm\n' }));
    expect(none.find((x) => x.key.startsWith('repeated:'))).toBeUndefined();
    expect(none.find((x) => x.key === 'missing-claude-md')).toBeUndefined();
  });

  it('mcp-opportunity: suggests a server after 3 shell calls unless it is already loaded', () => {
    const events = [1, 2, 3].map(() => ev('post_tool', { tool_name: 'Bash', tool_input: { command: 'gh pr view 57 --json state' } }));
    const s = mcpOpportunity.evaluate(ctx({ events, loaded: { mcp: [], skills: [], plugins: [] } }));
    expect(s[0]!.key).toBe('mcp-op:github');
    expect(s[0]!.action.kind).toBe('snippet');
    expect((s[0]!.action as { snippet: string }).snippet).toContain('claude mcp add github');
    expect(mcpOpportunity.evaluate(ctx({ events, loaded: { mcp: ['github'], skills: [], plugins: [] } })).length).toBe(0);
    const docs = [1, 2, 3].map(() => ev('post_tool', { tool_name: 'WebFetch', tool_input: { url: 'https://docs.example.com/api' } }));
    expect(mcpOpportunity.evaluate(ctx({ events: docs }))[0]!.key).toBe('mcp-op:context7');
  });

  it('dead-weight: reports unused items with measured first-turn overhead across sessions', () => {
    const repo = CWD.replace(/\\/g, '/').toLowerCase();
    const history: HistoryEntry[] = [1, 2, 3, 4].map((i) => ({ kind: 'session', repo, session: `s${i}`, loaded: { mcp: ['github', 'postgres'], skills: ['deploy-checklist'], plugins: [] }, used: { mcp: ['github'], skills: [] }, first_turn_tokens: 45000 }));
    const s = deadWeight.evaluate(ctx({ history }));
    const names = s.map((x) => x.key);
    expect(names).toContain('dead:mcp:postgres:watch');
    expect(names).toContain('dead:skill:deploy-checklist:watch');
    expect(names.some((n) => n.startsWith('dead:mcp:github'))).toBe(false);
    expect(s[0]!.message).toContain('45,000');
    expect(s[0]!.message).toContain('30,000 above baseline');
    expect(s[0]!.message).toContain('Estimated');
    expect(s[0]!.message).toContain('Recommendation: watch');
    expect(s[0]!.message).toContain('/plugin Stats');
    expect(s[0]!.message).toContain('"Not used recently"');
    expect(s[0]!.action.kind).toBe('none');
    expect(deadWeight.evaluate(ctx({ history: history.slice(0, 2) })).length).toBe(0);
  });

  it('mcp-errors: fires after 3 errors from the same MCP tool', () => {
    const s = mcpErrors.evaluate(ctx());
    expect(s.length).toBe(1);
    expect(s[0]!.title).toContain('jira MCP failed 3');
    expect(s[0]!.action.kind).toBe('inject');
  });

  it('permission-friction: suggests an allowlist entry or /fewer-permission-prompts', () => {
    const events = [1, 2].map(() => ev('permission', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash(npm test)' }));
    const s = permissionFriction.evaluate(ctx({ events }));
    expect(s.length).toBe(1);
    expect(s[0]!.message).toContain('/fewer-permission-prompts');
    expect(s[0]!.action.kind).toBe('settings');
    expect((s[0]!.action as { snippet: string }).snippet).toContain('Bash(npm test:*)');
    expect(permissionFriction.evaluate(ctx({ events: events.slice(0, 1) })).length).toBe(0);
  });

  it('burn-rate: flags spend without edits and budget thresholds', () => {
    const t = transcript();
    const now = new Date(Date.parse(t.messages[10]!.ts) + 60000);
    const noEdits = fixtureEvents().filter((e) => !['Edit', 'Write'].includes(String(e.data.tool_name)));
    const heavy = { ...t, messages: t.messages.map((m) => ({ ...m, cost: 0.4 })) };
    const s = burnRate.evaluate(ctx({ transcript: heavy, events: noEdits, now, task: null }));
    expect(s.find((x) => x.key.startsWith('burn:'))).toBeTruthy();
    const over = burnRate.evaluate(ctx({ spendUsd: 12, task: task({ budget_usd: 10 }), transcript: undefined }));
    expect(over[0]!.key).toBe('budget:100');
    expect(over[0]!.severity).toBe('critical');
    const warn = burnRate.evaluate(ctx({ spendUsd: 8.5, task: task({ budget_usd: 10 }), transcript: undefined }));
    expect(warn[0]!.key).toBe('budget:80');
    expect(burnRate.evaluate(ctx({ spendUsd: 2, task: task({ budget_usd: 10 }), transcript: undefined })).length).toBe(0);
  });

  it('task-quality: no-task and vague-task', () => {
    const none = taskQuality.evaluate(ctx({ task: null }));
    expect(none[0]!.key).toBe('no-task');
    const vague = taskQuality.evaluate(ctx({ task: task({ needs_clarification: true, spec_quality: { score: 3, missing: ['done criteria'], questions: ['What is done?'] } }) }));
    expect(vague[0]!.title).toContain('Clarify the ticket first');
    expect(vague[0]!.message).toContain('What is done?');
    expect(taskQuality.evaluate(ctx({ task: task() })).length).toBe(0);
  });

  it('history-lesson: surfaces recommendations and rework at session start only', () => {
    const repo = CWD.replace(/\\/g, '/').toLowerCase();
    const history: HistoryEntry[] = [{ repo, task_title: 'Old task', verdict: 'worth it', final_status: 'reverted', recommendations: ['Write the failing test first.'] }];
    const first = ctx({ history, events: fixtureEvents().filter((e) => e.type !== 'prompt').concat([ev('prompt', { prompt: 'hi' })]) });
    const s = historyLesson.evaluate(first);
    expect(s.length).toBe(1);
    expect(s[0]!.message).toContain('reverted');
    expect(s[0]!.message).toContain('Write the failing test first.');
    expect(historyLesson.evaluate(ctx({ history })).length).toBe(0);
  });
});

describe('noise control', () => {
  it('shows at most one non-critical per interval and 8 per session, but always shows critical', () => {
    const cfg = loadConfig();
    const engine = new CoachEngine(loadState('fx'), cfg, RULES, {});
    const base = ctx({ task: task({ budget_usd: 0.1 }), spendUsd: 1, contextTokensNow: 175000, contextWindow: 200000, claudeMd: null });
    const r1 = engine.tick(base);
    const crit = r1.show.filter((s) => s.severity === 'critical');
    expect(crit.length).toBeGreaterThanOrEqual(3);
    expect(r1.show.filter((s) => s.severity !== 'critical').length).toBe(1);
    expect(r1.held.length).toBeGreaterThan(0);
    const r2 = engine.tick({ ...base, now: new Date(base.now.getTime() + 60000) });
    expect(r2.show.length).toBe(0);
    const r3 = engine.tick({ ...base, now: new Date(base.now.getTime() + 181000) });
    expect(r3.show.length).toBe(1);
    expect(r3.show[0]!.severity).not.toBe('critical');
    let t = base.now.getTime() + 181000;
    for (let i = 0; i < 12; i++) {
      t += 181000;
      engine.tick({ ...base, now: new Date(t) });
    }
    expect(engine.state.shown).toBeLessThanOrEqual(cfg.coach.max_per_session);
    const shownKeys = new Set(engine.state.shown_keys);
    expect(shownKeys.size).toBe(engine.state.shown_keys.length);
  });

  it('ranks by severity then dollars saved', () => {
    const engine = new CoachEngine(loadState('r'), loadConfig(), RULES, {});
    const c = ctx();
    const cands = engine.evaluate(c);
    const r = engine.tick({ ...c, now: new Date(c.now.getTime() + 100000) }, cands);
    const nonCrit = r.show.find((s) => s.severity !== 'critical');
    const heldBest = r.held[0];
    if (nonCrit && heldBest && nonCrit.severity === heldBest.severity) expect(nonCrit.usd_saved).toBeGreaterThanOrEqual(heldBest.usd_saved);
  });

  it('auto-mutes a rule after 3 skips, per repo', () => {
    const engine = new CoachEngine(loadState('m'), loadConfig(), RULES, {});
    expect(engine.recordSkip(CWD, 'reread').muted).toBe(false);
    expect(engine.recordSkip(CWD, 'reread').muted).toBe(false);
    expect(engine.recordSkip(CWD, 'reread').muted).toBe(true);
    expect(isMuted(CWD, 'reread')).toBe(true);
    expect(isMuted('C:/other', 'reread')).toBe(false);
    const r = engine.tick(ctx());
    expect(r.show.find((s) => s.rule === 'reread')).toBeUndefined();
    expect(r.suppressed.find((s) => s.suggestion.rule === 'reread')?.why).toBe('muted');
  });

  it('rate-limits LLM coaching to one call per 90s with new activity', () => {
    const engine = new CoachEngine(loadState('l'), loadConfig(), RULES, {});
    const now = new Date();
    expect(engine.llmAllowed(now, 10)).toBe(true);
    engine.markLlm(now, 10);
    expect(engine.llmAllowed(new Date(now.getTime() + 30000), 30)).toBe(false);
    expect(engine.llmAllowed(new Date(now.getTime() + 91000), 12)).toBe(false);
    expect(engine.llmAllowed(new Date(now.getTime() + 91000), 16)).toBe(true);
  });

  it('never throws when a rule throws', () => {
    const bad = { id: 'bad', describe: '', evaluate: () => { throw new Error('boom'); } };
    const engine = new CoachEngine(loadState('b'), loadConfig(), [bad], {});
    expect(engine.tick(ctx()).show.length).toBe(0);
  });
});

describe('fixture-driven demo expectations', () => {
  it('yields at least 5 distinct suggestions across the fixture session', () => {
    const engine = new CoachEngine(loadState('d'), loadConfig(), RULES, {});
    const repo = CWD.replace(/\\/g, '/').toLowerCase();
    const history: HistoryEntry[] = [1, 2, 3].map((i) => ({ kind: 'session', repo, session: `h${i}`, loaded: { mcp: ['github', 'jira', 'postgres'], skills: ['deploy-checklist'], plugins: [] }, used: { mcp: ['github'], skills: [] }, first_turn_tokens: 40000 }));
    const all = engine.evaluate(ctx({ history, claudeMd: null, task: task({ needs_clarification: true, spec_quality: { score: 3, missing: ['x'], questions: ['y'] } }) }));
    expect(new Set(all.map((s) => s.rule)).size).toBeGreaterThanOrEqual(5);
    fs.rmSync(tmpDir(), { recursive: true, force: true });
  });
});
