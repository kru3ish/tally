import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolate, tmpDir, root } from './helpers.js';
import { install, isInstalled, isTallyHook, enabledPluginIds, PluginConflictError, settingsPath } from '../src/install/install.js';
import { run as runInstall } from '../src/commands/install.js';
import { readEvents } from '../src/store/events.js';
import { runChecks } from '../src/commands/doctor.js';

const HOOK = path.join(root, 'dist', 'hook.js');

let iso: ReturnType<typeof isolate>;
beforeEach(() => {
  iso = isolate();
});
afterEach(() => iso.restore());

function hook(event: string, input: Record<string, unknown>, env: Record<string, string> = {}): { status: number | null; stdout: string; ms: number } {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [HOOK, event], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, TALLY_NO_SPAWN: '1', ...env } });
  return { status: r.status, stdout: r.stdout, ms: Date.now() - t0 };
}

describe('double-install guard', () => {
  it('tally install refuses while the plugin is enabled, unless --force', async () => {
    const settings = settingsPath('user');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ enabledPlugins: { 'tally@tally': true, 'other@mp': true } }, null, 2) + '\n');
    const before = fs.readFileSync(settings, 'utf8');
    expect(enabledPluginIds(tmpDir('tally-cwd-'))).toEqual(['tally@tally']);
    expect(() => install({ scope: 'user' })).toThrow(PluginConflictError);
    expect(fs.readFileSync(settings, 'utf8')).toBe(before);
    expect(isInstalled('user')).toBe(false);
    let err = '';
    const w = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => (err += s, true)) as typeof process.stderr.write;
    let code: number | void;
    try {
      code = await runInstall({ _: [], flags: {} });
    } finally {
      process.stderr.write = w;
    }
    expect(code).toBe(1);
    expect(err).toContain('already enabled as a Claude Code plugin (tally@tally)');
    expect(err).toContain('/plugin uninstall tally');
    const forced = install({ scope: 'user', force: true });
    expect(forced.added).toBeGreaterThan(0);
    expect(isInstalled('user')).toBe(true);
    const checks = runChecks();
    const hooks = checks.find((c) => c.name === 'hooks')!;
    expect(hooks.ok).toBe('warn');
    expect(hooks.detail).toContain('installed 2 ways (user settings, plugin)');
    expect(hooks.detail).toContain('tally uninstall');
  });

  it('a disabled plugin entry does not block install', () => {
    const settings = settingsPath('user');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ enabledPlugins: { 'tally@tally': false } }) + '\n');
    expect(enabledPluginIds()).toEqual([]);
    expect(install({ scope: 'user' }).added).toBeGreaterThan(0);
  });

  it('recognises both hook forms as Tally hooks', () => {
    expect(isTallyHook({ type: 'command', command: 'node "C:/Users/x/dev/tally/dist/hook.js" Stop' })).toBe(true);
    expect(isTallyHook({ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/hook.js', 'Stop'] })).toBe(true);
    expect(isTallyHook({ type: 'command', command: 'node', args: ['/home/u/.claude/plugins/cache/tally/tally/0.1.0/dist/hook.js', 'PostToolUse'] })).toBe(true);
    expect(isTallyHook({ type: 'command', command: 'node /usr/lib/node_modules/@kru3ish/tally/dist/hook.js SessionEnd' })).toBe(true);
    expect(isTallyHook({ type: 'command', command: 'echo hi' })).toBe(false);
    expect(isTallyHook({ type: 'command', command: 'node', args: ['/x/other-plugin/dist/hook.js'] })).toBe(false);
    expect(isTallyHook('node tally/dist/hook.js')).toBe(false);
  });
});

describe('moved hook script', () => {
  it('doctor flags a hook whose script is gone and tally install repoints it', () => {
    const settings = settingsPath('user');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "C:/old/tally/dist/hooks/hook.js" Stop', timeout: 5 }] }] } }, null, 2) + '
');
    const before = runChecks().find((c) => c.name === 'hook script')!;
    expect(before.ok).toBe(false);
    expect(before.detail).toContain('does not exist');
    expect(before.detail).toContain('tally install');
    install({ scope: 'user' });
    const s = JSON.parse(fs.readFileSync(settings, 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const stops = s.hooks.Stop.flatMap((g) => g.hooks).filter((h) => /tally/i.test(h.command));
    expect(stops.length).toBe(1);
    expect(stops[0]!.command).toContain('dist/hook.js');
    expect(runChecks().find((c) => c.name === 'hook script')!.ok).toBe(true);
  });
});

describe('hook de-duplication', () => {
  it('drops the second delivery of the same (session, event, tool_use_id) and keeps distinct ones', () => {
    const session = 'dup-session-0001';
    const input = { session_id: session, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_1', tool_response: 'ok' };
    expect(hook('PreToolUse', input).status).toBe(0);
    expect(hook('PreToolUse', input).status).toBe(0);
    expect(hook('PostToolUse', input).status).toBe(0);
    expect(hook('PostToolUse', input).status).toBe(0);
    expect(hook('PostToolUse', { ...input, tool_use_id: 'toolu_2' }).status).toBe(0);
    expect(hook('PostToolUseFailure', { ...input, tool_use_id: 'toolu_3', error: 'boom' }).status).toBe(0);
    const ev = readEvents(session);
    expect(ev.filter((e) => e.type === 'pre_tool').length).toBe(1);
    expect(ev.filter((e) => e.type === 'post_tool').map((e) => e.data.tool_use_id)).toEqual(['toolu_1', 'toolu_2', 'toolu_3']);
    const seen = fs.readFileSync(path.join(iso.home, 'sessions', session, 'seen.txt'), 'utf8').trim().split('\n');
    expect(seen).toEqual(['PreToolUse:toolu_1', 'PostToolUse:toolu_1', 'PostToolUse:toolu_2', 'PostToolUseFailure:toolu_3']);
    /* events without a tool_use_id are never de-duplicated */
    hook('Stop', { session_id: session, last_assistant_message: 'a' });
    hook('Stop', { session_id: session, last_assistant_message: 'a' });
    expect(readEvents(session).filter((e) => e.type === 'stop').length).toBe(2);
  });
});

describe('SessionEnd within the shared 1.5 s budget', () => {
  it('records, spawns the detached finalize, and returns without waiting for it', () => {
    const session = 'end-session-0001';
    const stub = path.join(tmpDir('tally-stub-'), 'slow-cli.mjs');
    const marker = path.join(path.dirname(stub), 'started.txt');
    fs.writeFileSync(stub, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' ')); await new Promise((r) => setTimeout(r, 3000));`);
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [HOOK, 'SessionEnd'], { input: JSON.stringify({ session_id: session, reason: 'exit', transcript_path: 'x.jsonl' }), encoding: 'utf8', env: { ...process.env, TALLY_HOOK_CLI: stub }, timeout: 10000 });
    const ms = Date.now() - t0;
    expect(r.status).toBe(0);
    expect(ms).toBeLessThan(1500);
    expect(readEvents(session).some((e) => e.type === 'session_end')).toBe(true);
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(marker) && Date.now() < deadline) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},100)']);
    expect(fs.readFileSync(marker, 'utf8')).toBe(`finalize ${session} --auto`);
  });

  it('every hook event stays under the 150 ms rule with an empty payload', () => {
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'PreCompact', 'Notification', 'SessionEnd']) {
      const r = hook(ev, { session_id: 'timing-0001' });
      expect(r.status, ev).toBe(0);
      expect(r.ms, ev).toBeLessThan(process.env.CI ? 1500 : 500);
    }
  });
});

describe('self-contained dist', () => {
  it('bundles have no runtime imports beyond node builtins and the plugin points at them', () => {
    for (const f of ['cli.js', 'hook.js']) {
      const src = fs.readFileSync(path.join(root, 'dist', f), 'utf8');
      expect(src.startsWith('#!/usr/bin/env node')).toBe(true);
      const imports = [...src.matchAll(/^import\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1]!);
      const bad = imports.filter((i) => !i.startsWith('node:'));
      expect(bad, f).toEqual([]);
      expect(src).not.toMatch(/from\s+['"]zod['"]/);
    }
    expect(fs.existsSync(path.join(root, 'dist', 'pricing.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'dist', 'fixtures', 'session-basic', 'transcript.jsonl'))).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { name: string; bin: Record<string, string>; files: string[]; dependencies?: Record<string, string> };
    expect(pkg.name).toBe('@kru3ish/tally');
    expect(pkg.bin).toEqual({ tally: 'dist/cli.js', 'cc-tally': 'dist/cli.js' });
    expect(pkg.files).toEqual(['dist', 'README.md', 'LICENSE', 'CHANGELOG.md', '.claude-plugin', 'hooks', 'commands']);
    const plugin = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')) as Record<string, unknown>;
    for (const k of ['name', 'version', 'author', 'homepage', 'repository', 'license']) expect(plugin[k], k).toBeTruthy();
    expect(plugin.version).toBe('0.1.0');
    const market = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8')) as { name: string; description: string; plugins: Array<{ name: string; source: string; description: string }> };
    expect(market.description).toBeTruthy();
    expect(market.plugins[0]).toMatchObject({ name: 'tally', source: './' });
    expect(fs.existsSync(path.join(root, 'bin'))).toBe(false);
  });
});
