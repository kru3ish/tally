import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolate, root, tmpDir } from './helpers.js';
import { readEvents } from '../src/store/events.js';
import { install, uninstall, isInstalled, settingsPath, HOOK_EVENTS, isTallyHook } from '../src/install/install.js';

const HOOK = path.join(root, 'dist', 'hook.js');

let iso: ReturnType<typeof isolate>;
beforeEach(() => {
  iso = isolate();
  process.env.TALLY_NO_SPAWN = '1';
});
afterEach(() => {
  iso.restore();
  delete process.env.TALLY_NO_SPAWN;
});

function runHook(event: string, stdin: string): { code: number | null; stdout: string; ms: number } {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [HOOK, event], { input: stdin, env: { ...process.env }, encoding: 'utf8', timeout: 5000 });
  return { code: r.status, stdout: r.stdout, ms: performance.now() - t0 };
}

describe('hook entry', () => {
  it('is built', () => {
    expect(fs.existsSync(HOOK)).toBe(true);
  });

  it('exits 0 on garbage, empty, and non-object input', () => {
    for (const bad of ['', 'not json', '[1,2]', 'null', '{"session_id":', '\u0000\u0001']) {
      const r = runHook('PostToolUse', bad);
      expect(r.code).toBe(0);
    }
  });

  it('finishes under 150ms (median of 5 runs)', () => {
    runHook('PostToolUse', '{}');
    const times: number[] = [];
    for (let i = 0; i < 5; i++) times.push(runHook('PostToolUse', JSON.stringify({ session_id: 'perf', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'ok' })).ms);
    times.sort((a, b) => a - b);
    expect(times[2]!).toBeLessThan(150);
  });

  it('makes no network calls and imports only builtins plus tally internals', () => {
    const src = fs.readFileSync(HOOK, 'utf8');
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).not.toMatch(/from ['"](https?|net|dns|tls|http2)['"]/);
    const imports = [...src.matchAll(/from ['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    for (const i of imports) expect(i.startsWith('node:') || i.startsWith('../') || i.startsWith('./')).toBe(true);
  });

  it('records tool events and redacts secrets', () => {
    const r = runHook(
      'PostToolUse',
      JSON.stringify({ session_id: 'sess-1', cwd: 'C:/repo', tool_name: 'Bash', tool_input: { command: 'curl -H "Authorization: Bearer ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234" api' }, tool_response: 'token=sk-ant-api03-SECRETSECRETSECRET done' }),
    );
    expect(r.code).toBe(0);
    const raw = fs.readFileSync(path.join(iso.home, 'sessions', 'sess-1', 'events.jsonl'), 'utf8');
    expect(raw).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234');
    expect(raw).not.toContain('SECRETSECRETSECRET');
    const ev = readEvents('sess-1');
    expect(ev[0]!.type).toBe('post_tool');
    expect(ev[0]!.data.tool_name).toBe('Bash');
  });

  it('detects a git push as a ship event and requests a judge run', () => {
    runHook('PostToolUse', JSON.stringify({ session_id: 'sess-2', cwd: 'C:/repo', tool_name: 'Bash', tool_input: { command: 'git push -u origin feature/x' }, tool_response: 'To github.com:acme/app.git\n * [new branch]' }));
    const ev = readEvents('sess-2');
    expect(ev.map((e) => e.type)).toEqual(['post_tool', 'ship']);
    expect(ev[1]!.data.kind).toBe('push');
    const spawns = fs.readFileSync(path.join(iso.home, 'spawn.log'), 'utf8');
    expect(spawns).toContain('"judge"');
    expect(spawns).toContain('sess-2');
  });

  it('does not treat a failed push as a ship', () => {
    runHook('PostToolUseFailure', JSON.stringify({ session_id: 'sess-3', tool_name: 'Bash', tool_input: { command: 'git push' }, error: 'rejected' }));
    expect(readEvents('sess-3').map((e) => e.type)).toEqual(['post_tool']);
    expect(readEvents('sess-3')[0]!.data.is_error).toBe(true);
  });

  it('delivers the inject queue on UserPromptSubmit exactly once', () => {
    const dir = path.join(iso.home, 'sessions', 'sess-4');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'inject.jsonl'), JSON.stringify({ note: 'Run the tests before pushing.' }) + '\n');
    fs.writeFileSync(path.join(dir, 'task.json'), '{}');
    const r1 = runHook('UserPromptSubmit', JSON.stringify({ session_id: 'sess-4', prompt: 'continue' }));
    expect(r1.code).toBe(0);
    const out = JSON.parse(r1.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(out.hookSpecificOutput.additionalContext).toBe('Tally: Run the tests before pushing.');
    const r2 = runHook('UserPromptSubmit', JSON.stringify({ session_id: 'sess-4', prompt: 'again' }));
    expect(r2.stdout).toBe('');
  });

  it('auto-detects a task URL in the first prompt and records the session start inventory', () => {
    fs.mkdirSync(path.join(iso.claude), { recursive: true });
    fs.writeFileSync(path.join(iso.claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'superpowers@official': true } }));
    const repo = tmpDir('tally-repo-');
    fs.mkdirSync(path.join(repo, '.git', 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(repo, '.git', 'refs', 'heads', 'main'), 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n');
    runHook('SessionStart', JSON.stringify({ session_id: 'sess-5', cwd: repo, source: 'startup', model: 'claude-opus-5', transcript_path: 'x.jsonl' }));
    runHook('UserPromptSubmit', JSON.stringify({ session_id: 'sess-5', cwd: repo, prompt: 'Fix https://github.com/acme/app/issues/42 please' }));
    const ev = readEvents('sess-5');
    expect(ev[0]!.type).toBe('session_start');
    expect(ev[0]!.data.git_head).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
    expect((ev[0]!.data.loaded as { plugins: string[] }).plugins).toContain('superpowers');
    const spawns = fs.readFileSync(path.join(iso.home, 'spawn.log'), 'utf8');
    expect(spawns).toContain('https://github.com/acme/app/issues/42');
    const active = JSON.parse(fs.readFileSync(path.join(iso.home, 'active.json'), 'utf8')) as Record<string, unknown>;
    expect(active['sess-5']).toBeTruthy();
  });

  it('surfaces history lessons at session start', () => {
    fs.writeFileSync(path.join(iso.home, 'history.jsonl'), JSON.stringify({ repo: root.replace(/\\/g, '/').toLowerCase(), recommendations: ['Write the failing test before the fix.'], task_title: 'x', verdict: 'worth it', final_status: 'reverted' }) + '\n');
    const r = runHook('SessionStart', JSON.stringify({ session_id: 'sess-6', cwd: root, source: 'startup' }));
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { additionalContext: string } };
    expect(out.hookSpecificOutput.additionalContext).toContain('Write the failing test before the fix.');
    expect(out.hookSpecificOutput.additionalContext).toContain('reverted');
  });

  it('records session end and clears active', () => {
    runHook('Stop', JSON.stringify({ session_id: 'sess-7', last_assistant_message: 'done' }));
    runHook('SessionEnd', JSON.stringify({ session_id: 'sess-7', reason: 'other' }));
    expect(readEvents('sess-7').map((e) => e.type)).toEqual(['stop', 'session_end']);
    const active = JSON.parse(fs.readFileSync(path.join(iso.home, 'active.json'), 'utf8')) as Record<string, unknown>;
    expect(active['sess-7']).toBeUndefined();
    expect(fs.readFileSync(path.join(iso.home, 'spawn.log'), 'utf8')).toContain('"finalize"');
  });
});

describe('install / uninstall', () => {
  it('round-trips user settings byte-identically, preserving odd formatting', () => {
    const file = settingsPath('user');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = '{\n\t"model": "opus",\n\t"permissions": {"allow": ["Bash(npm:*)"]},\n\t"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo hi"}]}]}\n}';
    fs.writeFileSync(file, original);
    const r = install({ scope: 'user' });
    expect(r.added).toBe(HOOK_EVENTS.length);
    expect(isInstalled('user')).toBe(true);
    const mid = JSON.parse(fs.readFileSync(file, 'utf8')) as { hooks: Record<string, unknown[]>; model: string };
    expect(mid.model).toBe('opus');
    expect(mid.hooks.Stop!.length).toBe(2);
    expect(mid.hooks.PostToolUse!.length).toBe(1);
    expect(install({ scope: 'user' }).added).toBe(0);
    const u = uninstall({ scope: 'user' });
    expect(u.removed).toBe(HOOK_EVENTS.length);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(isInstalled('user')).toBe(false);
  });

  it('round-trips a missing settings file to missing', () => {
    const file = settingsPath('user');
    expect(fs.existsSync(file)).toBe(false);
    install({ scope: 'user' });
    expect(fs.existsSync(file)).toBe(true);
    uninstall({ scope: 'user' });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('supports project scope', () => {
    const cwd = tmpDir('tally-proj-');
    const file = settingsPath('project', cwd);
    install({ scope: 'project', cwd });
    expect(fs.existsSync(file)).toBe(true);
    expect(isInstalled('project', cwd)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string; async?: boolean }> }>> };
    expect(parsed.hooks.PostToolUse![0]!.hooks[0]!.async).toBe(true);
    expect(parsed.hooks.SessionStart![0]!.hooks[0]!.async).toBeUndefined();
    expect(parsed.hooks.PostToolUse![0]!.hooks[0]!.command).toMatch(/dist\/hook\.js" PostToolUse$/);
    uninstall({ scope: 'project', cwd });
    expect(fs.existsSync(file)).toBe(false);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('keeps user edits made after install when uninstalling', () => {
    const file = settingsPath('user');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"model":"opus"}\n');
    install({ scope: 'user' });
    const s = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    s.theme = 'dark';
    fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
    uninstall({ scope: 'user' });
    const after = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(after.theme).toBe('dark');
    expect(after.hooks).toBeUndefined();
  });
});

describe('plugin manifest', () => {
  it('has a valid plugin.json, marketplace.json, and hooks.json covering every event', () => {
    const plugin = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')) as { name: string; hooks?: string; commands?: string[] };
    expect(plugin.name).toBe('tally');
    /* hooks/hooks.json and commands/ are loaded by convention; naming them again in the manifest makes the plugin fail to load ("Duplicate hooks file") */
    expect(plugin.hooks).toBeUndefined();
    expect(plugin.commands).toBeUndefined();
    const hooks = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string; args: string[] }> }>> };
    for (const { event } of HOOK_EVENTS) {
      expect(hooks.hooks[event]).toBeTruthy();
      const h = hooks.hooks[event]![0]!.hooks[0]!;
      /* exec form: no shell, so Windows can spawn it (a .cmd shim could not be) */
      expect(h.command).toBe('node');
      expect(h.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/dist/hook.js', event]);
      expect(isTallyHook(h)).toBe(true);
    }
    const market = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8')) as { plugins: Array<{ name: string }> };
    expect(market.plugins[0]!.name).toBe('tally');
    for (const c of ['tally.md', 'task.md', 'judge.md', 'report.md', 'coach.md', 'statusline.md', 'explain.md', 'dispute.md', 'budget.md']) expect(fs.existsSync(path.join(root, 'commands', c))).toBe(true);
  });
});
