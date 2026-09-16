import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { isolate, basicFixture, tmpDir, root } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { applySuggestion, injectSuggestion, skipSuggestion, mergePatch, isAutoApplicable } from '../src/coach/actions.js';
import { enqueueInject, pendingInjects, readInjects } from '../src/coach/inject.js';
import { readUndoLog, undoLast } from '../src/coach/undo.js';
import { renderHeader, renderSuggestion, watch } from '../src/coach/ui.js';
import { buildContext } from '../src/coach/context.js';
import { readEvents, readEventsFile, appendEvent } from '../src/store/events.js';
import { StubLlm } from '../src/llm/client.js';
import type { Suggestion } from '../src/coach/types.js';

let iso: ReturnType<typeof isolate>;
beforeEach(() => {
  iso = isolate();
});
afterEach(() => iso.restore());

const sug = (over: Partial<Suggestion> = {}): Suggestion => ({
  rule: 'reread',
  key: 'k1',
  severity: 'warn',
  title: 'T',
  message: 'M',
  usd_saved: 1,
  action: { kind: 'inject', label: 'tell', note: 'Stop re-reading.' },
  ...over,
});

describe('actions', () => {
  it('inject queues a note that the hook delivers with the [Tally] prefix', () => {
    const r = injectSuggestion(sug(), { session: 's', cwd: 'C:/x' });
    expect(r.injected).toBe(true);
    expect(pendingInjects('s')[0]!.note).toBe('Stop re-reading.');
    const hook = spawnSync(process.execPath, [path.join(root, 'dist', 'hook.js'), 'UserPromptSubmit'], { input: JSON.stringify({ session_id: 's', prompt: 'x' }), encoding: 'utf8', env: { ...process.env, TALLY_NO_SPAWN: '1' } });
    expect(hook.stdout).toContain('Tally: Stop re-reading.');
    expect(pendingInjects('s').length).toBe(0);
    expect(readInjects('s')[0]!.delivered).toBe(true);
    expect(readEvents('s').some((e) => e.type === 'inject')).toBe(true);
  });

  it('write_md create/append/replace with undo, and refuses non-md files', () => {
    const cwd = tmpDir('tally-md-');
    const file = path.join(cwd, 'CLAUDE.md');
    const cfg = loadConfig();
    const create = applySuggestion(sug({ rule: 'claude-md', action: { kind: 'write_md', label: 'c', file, content: '# repo\n', mode: 'create' } }), { session: 's', cwd, cfg, mode: 'ask' });
    expect(create.ok).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('# repo\n');
    expect(applySuggestion(sug({ action: { kind: 'write_md', label: 'c', file, content: 'x', mode: 'create' } }), { session: 's', cwd, cfg, mode: 'ask' }).ok).toBe(false);
    const append = applySuggestion(sug({ key: 'k2', action: { kind: 'write_md', label: 'a', file, content: '- Always use bun\n', mode: 'append' } }), { session: 's', cwd, cfg, mode: 'ask' });
    expect(append.ok).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('# repo\n- Always use bun\n');
    const handoff = path.join(cwd, 'HANDOFF.md');
    const rep = applySuggestion(sug({ key: 'k3', rule: 'context-pressure', inject_note: 'read HANDOFF.md', action: { kind: 'write_md', label: 'h', file: handoff, content: '# HANDOFF\n', mode: 'replace' } }), { session: 's', cwd, cfg, mode: 'auto' });
    expect(rep.ok).toBe(true);
    expect(rep.injected).toBe(true);
    expect(pendingInjects('s').map((i) => i.note)).toEqual(['read HANDOFF.md']);
    expect(applySuggestion(sug({ action: { kind: 'write_md', label: 'x', file: path.join(cwd, 'a.ts'), content: '', mode: 'replace' } }), { session: 's', cwd, cfg, mode: 'ask' }).ok).toBe(false);
    expect(readUndoLog().length).toBe(3);
    const undone = undoLast(1);
    expect(undone[0]!.file).toBe(handoff);
    expect(fs.existsSync(handoff)).toBe(false);
    undoLast(1);
    expect(fs.readFileSync(file, 'utf8')).toBe('# repo\n');
    undoLast(1);
    expect(fs.existsSync(file)).toBe(false);
    expect(readUndoLog().every((e) => e.undone)).toBe(true);
    expect(readEvents('s').filter((e) => e.type === 'apply').length).toBe(3);
  });

  it('settings changes need ask mode, merge arrays, and are undoable', () => {
    const cwd = tmpDir('tally-set-');
    const file = path.join(cwd, '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, model: 'opus' }, null, 2) + '\n');
    const s = sug({ rule: 'permission-friction', action: { kind: 'settings', label: 'allow', file, patch: { permissions: { allow: ['Bash(npm test:*)'] } }, snippet: '' } });
    expect(isAutoApplicable(s)).toBe(false);
    expect(applySuggestion(s, { session: 's', cwd, cfg: loadConfig(), mode: 'auto' }).ok).toBe(false);
    const r = applySuggestion(s, { session: 's', cwd, cfg: loadConfig(), mode: 'ask' });
    expect(r.ok).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { permissions: { allow: string[] }; model: string };
    expect(parsed.permissions.allow).toEqual(['Bash(ls:*)', 'Bash(npm test:*)']);
    expect(parsed.model).toBe('opus');
    undoLast();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).permissions.allow).toEqual(['Bash(ls:*)']);
    expect(mergePatch({ a: [1] }, { a: [1, 2], b: { c: 1 } })).toEqual({ a: [1, 2], b: { c: 1 } });
  });

  it('snippet actions never touch settings', () => {
    const cwd = tmpDir('tally-snip-');
    const r = applySuggestion(sug({ rule: 'mcp-opportunity', action: { kind: 'snippet', label: 's', snippet: 'claude mcp add github -- npx x', where: 'here' } }), { session: 's', cwd, cfg: loadConfig(), mode: 'ask' });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(r.file!, 'utf8')).toContain('claude mcp add github');
    expect(fs.existsSync(path.join(cwd, '.claude'))).toBe(false);
  });

  it('skip is recorded as an event', () => {
    skipSuggestion(sug(), { session: 's', cwd: 'C:/x' });
    expect(readEvents('s')[0]!.type).toBe('skip');
  });
});

describe('ui', () => {
  it('renders header and suggestions without color', () => {
    const events = readEventsFile(path.join(basicFixture, 'events.jsonl'));
    const ctx = buildContext({ session: 'fx', cwd: 'C:/x', cfg: loadConfig(), events, transcriptPath: path.join(basicFixture, 'transcript.jsonl'), history: [] });
    const h = renderHeader(ctx, false);
    expect(h).toContain('Tally Coach');
    expect(h).toContain('none linked');
    expect(h).toContain('context');
    const s = renderSuggestion(sug({ severity: 'critical' }), false, 1);
    expect(s).toContain('!! T');
    expect(s).toContain('[a]pply  [i]nject  [s]kip  [m]ute rule');
  });

  it('watch streams suggestions from a growing event log, respects noise limits, and auto-applies md writes in auto mode', async () => {
    const events = readEventsFile(path.join(basicFixture, 'events.jsonl'));
    const session = 'live';
    const cwd = tmpDir('tally-live-');
    for (const e of events.slice(0, 10)) appendEvent({ ...e, session, cwd });
    fs.copyFileSync(path.join(basicFixture, 'transcript.jsonl'), path.join(iso.home, 'sessions', session, 'transcript.jsonl'));
    const out = new PassThrough();
    let text = '';
    out.on('data', (d: Buffer) => (text += d.toString()));
    const cfg = loadConfig();
    cfg.auto_apply = 'auto';
    cfg.coach.min_interval_s = 0;
    let t = Date.parse('2026-09-10T15:00:00Z');
    const p = watch({ session, cwd, cfg, color: false, pollMs: 20, maxTicks: 6, output: out as unknown as NodeJS.WriteStream, input: new PassThrough() as unknown as NodeJS.ReadStream, now: () => new Date((t += 200000)), llm: new StubLlm({ coach: () => ({ has_suggestion: true, title: 'Scope creep', message: 'Stick to the ticket.', inject_note: 'Stay on the ticket.', severity: 'info', usd_saved: 2 }) }) });
    await new Promise((r) => setTimeout(r, 40));
    for (const e of events.slice(10)) appendEvent({ ...e, session, cwd });
    await p;
    expect(text).toContain('Tally Coach');
    expect(text).toContain('Same command failed 3');
    expect(text).toContain('auto-applied');
    expect(text).toContain('Scope creep');
    expect(pendingInjects(session).length).toBeGreaterThan(0);
    const state = JSON.parse(fs.readFileSync(path.join(iso.home, 'sessions', session, 'coach-state.json'), 'utf8')) as { shown: number };
    expect(state.shown).toBeLessThanOrEqual(cfg.coach.max_per_session);
  });
});

describe('cli smoke', () => {
  it('status, sessions, config, undo and coach --once run without a session', () => {
    const cli = path.join(root, 'dist', 'cli.js');
    for (const argv of [['status'], ['sessions'], ['config'], ['undo', '--list'], ['--version'], ['help']]) {
      const r = spawnSync(process.execPath, [cli, ...argv], { encoding: 'utf8', env: { ...process.env } });
      expect(r.status ?? 0).toBe(0);
    }
    const r = spawnSync(process.execPath, [cli, 'config', 'hourly_rate', '120'], { encoding: 'utf8', env: { ...process.env } });
    expect(r.stdout).toContain('hourly_rate = 120');
    expect(loadConfig().hourly_rate).toBe(120);
    const s = spawnSync(process.execPath, [cli, 'start'], { encoding: 'utf8', env: { ...process.env, TMUX: '', WT_SESSION: '', PATH: path.dirname(process.execPath) } });
    expect(s.stdout).toContain('tally watch');
    enqueueInject('x', 'n', 'test');
    expect(fs.existsSync(path.join(iso.home, 'sessions', 'x', 'inject.jsonl'))).toBe(true);
  });
});
