import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolate, basicFixture, tmpDir, root } from './helpers.js';
import { loadConfig, saveConfig } from '../src/config.js';
import { StubLlm } from '../src/llm/client.js';
import { intake } from '../src/task/intake.js';
import { readEvents, appendEvent, readEventsFile } from '../src/store/events.js';
import { pendingInjects } from '../src/coach/inject.js';
import { run as coachRun } from '../src/commands/coach.js';
import { renderStatusLine, readFlags } from '../src/commands/statusline.js';
import { install, uninstall, installStatusLine, uninstallStatusLine, isTallyStatusLine, settingsPath } from '../src/install/install.js';
import { historyFile, repoKey, appendLine, sessionDir } from '../src/paths.js';

const HOOK = path.join(root, 'dist', 'hook.js');

let iso: ReturnType<typeof isolate>;
beforeEach(() => {
  iso = isolate();
});
afterEach(() => iso.restore());

function hook(event: string, input: Record<string, unknown>): { status: number | null; stdout: string } {
  const r = spawnSync(process.execPath, [HOOK, event], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, TALLY_NO_SPAWN: '1' } });
  return { status: r.status, stdout: r.stdout };
}

const stubIntake = (session: string) =>
  new StubLlm({ intake: () => ({ title: 'Rate limit the login endpoint', criteria: [{ text: 'Login returns 429 above the limit', source: 'explicit', check: { kind: 'none' } }], spec_quality: { score: 8, missing: [], questions: [] }, estimate_hours: 2, rationale: '' }) }, session);

describe('autopilot', () => {
  it('the Stop hook spawns one Coach tick per turn, unless coach.autopilot is off', () => {
    const session = 'auto-session-0001';
    expect(hook('Stop', { session_id: session, cwd: 'C:/repo', last_assistant_message: 'done' }).status).toBe(0);
    const spawns = fs.readFileSync(path.join(iso.home, 'spawn.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args: string[] });
    expect(spawns.some((s) => s.args[0] === 'coach' && s.args[1] === '--tick' && s.args.includes(session) && s.args.includes('--auto'))).toBe(true);
    saveConfig({ coach: { autopilot: false } });
    fs.writeFileSync(path.join(iso.home, 'spawn.log'), '');
    hook('Stop', { session_id: session, cwd: 'C:/repo', last_assistant_message: 'done' });
    expect(fs.readFileSync(path.join(iso.home, 'spawn.log'), 'utf8').trim()).toBe('');
  });

  it('a tick queues observations for the next prompt, keeps the rest as status-line flags, and the hook delivers them under Tally:', async () => {
    const session = 'auto-session-0002';
    const cwd = tmpDir('tally-auto-');
    /* the fixture session has a loop (npm test fails 3×), repeated reads, and a failing MCP tool */
    for (const e of readEventsFile(path.join(basicFixture, 'events.jsonl'))) appendEvent({ ...e, session, cwd });
    await intake({ session, cwd, text: 'rate limit the login endpoint', cfg: loadConfig(), llm: stubIntake(session) });
    await coachRun({ _: [], flags: { tick: true, session, cwd, auto: true } });
    const queued = pendingInjects(session);
    expect(queued.length).toBeGreaterThan(0);
    for (const q of queued) expect(q.note).toMatch(/^Tally observed /);
    expect(readEvents(session).filter((e) => e.type === 'inject').length).toBe(queued.length);
    const flags = readFlags(session);
    /* the inferred task needs a human: it is a flag, never an injected instruction */
    expect(flags.pending.some((f) => f.rule === 'task-confirm')).toBe(true);
    const state = JSON.parse(fs.readFileSync(path.join(sessionDir(session), 'coach-state.json'), 'utf8')) as { shown: number };
    expect(state.shown).toBeGreaterThan(0);
    /* a second tick does not repeat itself */
    await coachRun({ _: [], flags: { tick: true, session, cwd, auto: true } });
    expect(pendingInjects(session).length).toBe(queued.length);
    const delivered = hook('UserPromptSubmit', { session_id: session, cwd, prompt: 'next' });
    expect(delivered.stdout).toContain('Tally: Tally observed');
    expect(pendingInjects(session).length).toBe(0);
  });

  it('the status line shows task, spend vs budget, context and flags from the JSON Claude Code passes', async () => {
    const session = 'auto-session-0003';
    const cwd = tmpDir('tally-status-');
    expect(renderStatusLine({ session_id: session, cost: { total_cost_usd: 0.42 } }, false)).toContain('no task linked · $0.420');
    await intake({ session, cwd, text: 'rate limit the login endpoint', cfg: loadConfig(), llm: stubIntake(session) });
    fs.writeFileSync(path.join(sessionDir(session), 'coach-flags.json'), JSON.stringify({ pending: [{ rule: 'task-confirm', key: 'k', title: 't', usd_saved: 1 }, { rule: 'claude-md', key: 'k2', title: 't2', usd_saved: 1 }] }));
    const line = renderStatusLine({ session_id: session, cost: { total_cost_usd: 30.5 }, context_window: { used_percentage: 72.4 } }, false);
    expect(line).toContain('Rate limit the login endpoint');
    expect(line).toContain('$30.50/$37.50 (81%)');
    expect(line).toContain('ctx 72%');
    expect(line).toContain('2 coach flags (/tally:coach)');
    const r = spawnSync(process.execPath, [path.join(root, 'dist', 'cli.js'), 'statusline', '--plain'], { input: JSON.stringify({ session_id: session, cost: { total_cost_usd: 1 } }), encoding: 'utf8', env: { ...process.env } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Rate limit the login endpoint');
    expect(renderStatusLine({}, false)).toContain('no task linked');
  });

  it('install adds the status line only when none is configured, and uninstall removes only Tally\'s', () => {
    const file = settingsPath('user');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{\n\t"model": "opus"\n}\n');
    const before = fs.readFileSync(file, 'utf8');
    const r = install({ scope: 'user' });
    expect(r.statusline).toBe(true);
    const s = JSON.parse(fs.readFileSync(file, 'utf8')) as { statusLine: { type: string; command: string } };
    expect(s.statusLine.type).toBe('command');
    expect(s.statusLine.command).toMatch(/dist\/cli\.js" statusline$/);
    expect(isTallyStatusLine(s.statusLine)).toBe(true);
    uninstall({ scope: 'user' });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    /* someone else's status line is left alone */
    fs.writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: 'my-status.sh' } }, null, 2) + '\n');
    expect(install({ scope: 'user' }).statusline).toBe(false);
    expect(installStatusLine().installed).toBe(false);
    expect(installStatusLine().reason).toContain('already configured');
    expect(installStatusLine({ force: true }).installed).toBe(true);
    expect(uninstallStatusLine().removed).toBe(true);
    expect((JSON.parse(fs.readFileSync(file, 'utf8')) as { statusLine?: unknown }).statusLine).toBeUndefined();
  });

  it('SessionStart opens with the last receipt for the repo', () => {
    const cwd = tmpDir('tally-last-');
    appendLine(historyFile(), JSON.stringify({ ts: '2026-09-15T10:00:00Z', session: 'old', repo: repoKey(cwd), verdict: 'borderline', task_title: 'Add rate limiting', completion_pct: 50, cost_usd: 1.33, waste_usd: 0.63, final_status: 'reverted', final_verdict: 'not worth it', recommendations: ['Read the ticket checklist before saying done.'] }));
    const r = hook('SessionStart', { session_id: 'auto-session-0004', cwd, source: 'startup' });
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { additionalContext: string } };
    expect(out.hookSpecificOutput.additionalContext).toContain('Tally: last receipt in this repo: "Add rate limiting" 50% complete, $1.33 spent, $0.63 waste, verdict not worth it (reverted).');
    expect(out.hookSpecificOutput.additionalContext).toContain('Read the ticket checklist');
  });
});
