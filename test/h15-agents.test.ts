import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolate, tmpDir, root } from './helpers.js';
import { agent, agentFromArgv, detectAgents, sessionFromEnv } from '../src/agents/index.js';
import { installAgent, uninstallAgent } from '../src/commands/install.js';
import { readEvents } from '../src/store/events.js';
import { parseTranscriptFile } from '../src/transcript/parse.js';
import { isCodexRollout } from '../src/transcript/codex.js';
import { loadPricing, costOf, canonicalModel } from '../src/cost/pricing.js';

const HOOK = path.join(root, 'dist', 'hook.js');

let iso: ReturnType<typeof isolate>;
let home: string;
const prevEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  iso = isolate();
  home = tmpDir('tally-agent-home-');
  for (const k of ['USERPROFILE', 'HOME', 'CODEX_HOME', 'GEMINI_SESSION_ID', 'TALLY_AGENT']) prevEnv[k] = process.env[k];
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  delete process.env.GEMINI_SESSION_ID;
  delete process.env.TALLY_AGENT;
});
afterEach(() => {
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  iso.restore();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

function hook(agentId: string, event: string, input: Record<string, unknown>) {
  return spawnSync(process.execPath, [HOOK, event, '--agent', agentId], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, TALLY_NO_SPAWN: '1' }, timeout: 20000 });
}

describe('agent adapters', () => {
  it('map each agent\'s events and payloads onto Claude Code\'s vocabulary', () => {
    const g = agent('gemini');
    expect(g.event('BeforeTool')).toBe('PreToolUse');
    expect(g.event('AfterAgent')).toBe('Stop');
    const gi = g.normalize({ session_id: 's1', cwd: 'C:/r', tool_name: 'run_shell_command', tool_input: { command: 'npm test' } }, 'BeforeTool');
    expect(gi.tool_name).toBe('Bash');
    expect(gi.tool_input?.command).toBe('npm test');
    expect(g.normalize({ tool_name: 'replace', tool_input: { file_path: 'a.ts' } }, 'BeforeTool').tool_name).toBe('Edit');

    const c = agent('cursor');
    expect(c.event('beforeShellExecution')).toBe('PreToolUse');
    const ci = c.normalize({ conversation_id: 'conv-1', workspace_roots: ['C:/ws'], command: 'git push' }, 'beforeShellExecution');
    expect(ci.session_id).toBe('conv-1');
    expect(ci.cwd).toBe('C:/ws');
    expect(ci.tool_name).toBe('Bash');
    expect(ci.tool_input?.command).toBe('git push');
    const ce = c.normalize({ conversation_id: 'conv-1', workspace_roots: ['C:/ws'], file_path: 'src/x.ts', edits: [] }, 'afterFileEdit');
    expect(ce.tool_name).toBe('Edit');
    expect(ce.hook_event_name).toBe('PostToolUse');

    const x = agent('codex');
    const xi = x.normalize({ session_id: 's2', cwd: 'C:/r', tool_name: 'apply_patch', tool_input: { input: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-1\n+2\n*** End Patch' } }, 'PreToolUse');
    expect(xi.tool_name).toBe('Edit');
    expect(xi.tool_input?.file_path).toBe('src/a.ts');
    const xs = x.normalize({ tool_name: 'shell', tool_input: { command: ['bash', '-lc', 'npm test'] } }, 'PreToolUse');
    expect(xs.tool_input?.command).toBe('bash -lc npm test');
  });

  it('shape Tally\'s answers the way each agent expects', () => {
    expect(agent('claude-code').output({ kind: 'deny', reason: 'r' })).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'r' } });
    expect(agent('codex').output({ kind: 'block', reason: 'r' })).toEqual({ decision: 'block', reason: 'r' });
    expect(agent('gemini').output({ kind: 'deny', reason: 'r' })).toMatchObject({ decision: 'deny', reason: 'r' });
    expect(agent('gemini').output({ kind: 'context', event: 'UserPromptSubmit', text: 't' })).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 't' } });
    expect(agent('cursor').output({ kind: 'deny', reason: 'r' })).toEqual({ permission: 'deny', user_message: 'r', agent_message: 'r' });
    expect(agent('cursor').output({ kind: 'block', reason: 'r' })).toEqual({ followup_message: 'r' });
    expect(agent('cursor').output({ kind: 'context', event: 'SessionStart', text: 't' })).toEqual({ additional_context: 't' });
  });

  it('is selected by --agent (anywhere in argv) or TALLY_AGENT, defaulting to Claude Code', () => {
    expect(agentFromArgv(['Stop', '--agent', 'codex']).adapter.id).toBe('codex');
    expect(agentFromArgv(['--agent=gemini', 'BeforeTool']).rest).toEqual(['BeforeTool']);
    expect(agentFromArgv(['Stop']).adapter.id).toBe('claude-code');
    process.env.TALLY_AGENT = 'cursor';
    expect(agentFromArgv(['stop']).adapter.id).toBe('cursor');
    process.env.GEMINI_SESSION_ID = 'g-1';
    expect(sessionFromEnv()).toBe('g-1');
  });

  it('the hook records Gemini, Cursor and Codex sessions with Claude-shaped events and answers in their dialect', () => {
    let r = hook('gemini', 'SessionStart', { session_id: 'gem-1', cwd: iso.home, transcript_path: null });
    expect(r.status).toBe(0);
    r = hook('gemini', 'BeforeTool', { session_id: 'gem-1', cwd: iso.home, tool_name: 'run_shell_command', tool_input: { command: 'npm test' } });
    expect(r.status).toBe(0);
    r = hook('gemini', 'AfterTool', { session_id: 'gem-1', cwd: iso.home, tool_name: 'run_shell_command', tool_input: { command: 'npm test' }, tool_response: { output: 'ok' } });
    const gem = readEvents('gem-1');
    expect(gem.map((e) => e.type)).toEqual(['session_start', 'pre_tool', 'post_tool']);
    expect(gem[1]!.data.tool_name).toBe('Bash');
    expect(gem[0]!.data.agent).toBe('gemini');

    r = hook('cursor', 'sessionStart', { conversation_id: 'cur-1', workspace_roots: [iso.home] });
    r = hook('cursor', 'beforeShellExecution', { conversation_id: 'cur-1', workspace_roots: [iso.home], command: 'git push origin main' });
    r = hook('cursor', 'afterShellExecution', { conversation_id: 'cur-1', workspace_roots: [iso.home], command: 'git push origin main', output: 'done' });
    const cur = readEvents('cur-1');
    expect(cur.map((e) => e.type)).toEqual(['session_start', 'pre_tool', 'post_tool', 'ship']);
    expect(cur[1]!.data.tool_name).toBe('Bash');

    /* a hard stop marker makes the PreToolUse answer come out in Cursor's permission shape */
    fs.writeFileSync(path.join(iso.home, 'sessions', 'cur-1', 'hard-stop.json'), JSON.stringify({ spend_usd: 9, budget_usd: 5 }));
    r = hook('cursor', 'beforeShellExecution', { conversation_id: 'cur-1', workspace_roots: [iso.home], command: 'rm -rf build' });
    expect(JSON.parse(r.stdout)).toMatchObject({ permission: 'deny' });
    fs.writeFileSync(path.join(iso.home, 'sessions', 'gem-1', 'hard-stop.json'), JSON.stringify({ spend_usd: 9, budget_usd: 5 }));
    r = hook('gemini', 'BeforeTool', { session_id: 'gem-1', cwd: iso.home, tool_name: 'run_shell_command', tool_input: { command: 'ls' } });
    expect(JSON.parse(r.stdout)).toMatchObject({ decision: 'deny' });

    r = hook('codex', 'PreToolUse', { session_id: 'cdx-1', cwd: iso.home, tool_name: 'apply_patch', tool_input: { input: '*** Begin Patch\n*** Update File: a.js\n*** End Patch' } });
    expect(readEvents('cdx-1')[0]!.data.tool_name).toBe('Edit');
  });

  it('install --agent writes the agent\'s hook file with a backup and uninstall removes only Tally\'s hooks', () => {
    for (const id of ['codex', 'gemini', 'cursor'] as const) {
      const a = agent(id);
      fs.mkdirSync(path.dirname(a.hooksFile()), { recursive: true });
      if (id === 'gemini') fs.writeFileSync(a.hooksFile(), JSON.stringify({ theme: 'dark', hooks: { BeforeTool: [{ matcher: '*', hooks: [{ name: 'mine', type: 'command', command: 'echo hi' }] }] } }));
      const r = installAgent(id, 'C:/x/hook.js');
      expect(r.file).toBe(a.hooksFile());
      expect(r.backup).toBeTruthy();
      const doc = JSON.parse(fs.readFileSync(a.hooksFile(), 'utf8')) as { version?: number; theme?: string; hooks: Record<string, unknown[]> };
      expect(Object.keys(doc.hooks).length).toBe(a.subscribed.length);
      const text = JSON.stringify(doc);
      expect(text).toContain(`--agent ${id}`);
      if (id === 'cursor') expect(doc.version).toBe(1);
      if (id === 'gemini') {
        expect(doc.theme).toBe('dark');
        expect(text).toContain('echo hi');
      }
      /* idempotent */
      installAgent(id, 'C:/x/hook.js');
      expect((JSON.stringify(JSON.parse(fs.readFileSync(a.hooksFile(), 'utf8'))).match(/--agent/g) ?? []).length).toBe(a.subscribed.length);
      expect(detectAgents().find((d) => d.id === id)!.installed).toBe(true);
      uninstallAgent(id);
      const after = JSON.stringify(JSON.parse(fs.readFileSync(a.hooksFile(), 'utf8')));
      expect(after).not.toContain('--agent');
      if (id === 'gemini') expect(after).toContain('echo hi');
    }
  });
});

describe('Codex rollout transcripts', () => {
  const rollout = (lines: unknown[]) => {
    const dir = path.join(tmpDir('tally-codex-'), '2026', '09', '26');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'rollout-2026-09-26T10-00-00-abc123.jsonl');
    fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return f;
  };

  it('parses session meta, prompts, tool calls with outputs, and token counts into cost by model', () => {
    const f = rollout([
      { timestamp: '2026-09-26T10:00:00.000Z', type: 'session_meta', payload: { id: 'cdx-sess-1', cwd: 'C:/Users/dev/app', cli_version: '0.50.0', model_provider: 'openai', timestamp: '2026-09-26T10:00:00.000Z' } },
      { timestamp: '2026-09-26T10:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.3-codex', cwd: 'C:/Users/dev/app' } },
      { timestamp: '2026-09-26T10:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the login rate limiter' }] } },
      { timestamp: '2026-09-26T10:00:05.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'npm test'] }), call_id: 'call_1' } },
      { timestamp: '2026-09-26T10:00:09.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: JSON.stringify({ output: '1 failing', metadata: { exit_code: 1 } }) } },
      { timestamp: '2026-09-26T10:00:10.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 12000, cached_input_tokens: 8000, output_tokens: 400, reasoning_output_tokens: 100, total_tokens: 12500 }, last_token_usage: { input_tokens: 12000, cached_input_tokens: 8000, output_tokens: 400, reasoning_output_tokens: 100, total_tokens: 12500 }, model_context_window: 400000 } } },
      { timestamp: '2026-09-26T10:00:12.000Z', type: 'response_item', payload: { type: 'function_call', name: 'apply_patch', arguments: JSON.stringify({ input: '*** Begin Patch\n*** Update File: src/login.js\n@@\n-a\n+b\n*** End Patch' }), call_id: 'call_2' } },
      { timestamp: '2026-09-26T10:00:13.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_2', output: 'Done!' } },
      { timestamp: '2026-09-26T10:00:20.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed and tests pass.' }] } },
      { timestamp: '2026-09-26T10:00:21.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 30000, cached_input_tokens: 20000, output_tokens: 900, reasoning_output_tokens: 300 }, last_token_usage: { input_tokens: 18000, cached_input_tokens: 12000, output_tokens: 500, reasoning_output_tokens: 200 }, model_context_window: 400000 } } },
    ]);
    expect(isCodexRollout(f)).toBe(true);
    const t = parseTranscriptFile(f);
    expect(t.sessionId).toBe('cdx-sess-1');
    expect(t.cwd).toBe('C:/Users/dev/app');
    expect(t.prompts.map((p) => p.text)).toEqual(['Fix the login rate limiter']);
    expect(t.toolCalls.map((c) => c.name)).toEqual(['Bash', 'Edit']);
    expect(t.toolCalls[0]!.input.command).toBe('bash -lc npm test');
    expect(t.toolCalls[0]!.result?.isError).toBe(true);
    expect(t.toolCalls[1]!.input.file_path).toBe('src/login.js');
    expect(t.models).toEqual(['gpt-5.3-codex']);
    expect(t.usage.input).toBe(10000);
    expect(t.usage.cache_read).toBe(20000);
    expect(t.usage.output).toBe(1200);
    const pricing = loadPricing();
    expect(t.cost).toBeCloseTo(costOf({ input: 10000, output: 1200, cache_write: 0, cache_write_1h: 0, cache_read: 20000 }, 'gpt-5.3-codex', pricing), 6);
    expect(t.cost).toBeGreaterThan(0);
    expect(t.cost_confidence).toBe('full');
    expect(t.finalAssistantText).toBe('Fixed and tests pass.');
    expect(t.entrypoint).toBe('codex');
  });

  it('prices OpenAI models and aliases codex variants to their base models', () => {
    const p = loadPricing();
    expect(canonicalModel('gpt-5-codex', p)).toBe('gpt-5');
    expect(canonicalModel('gpt-5.1-codex', p)).toBe('gpt-5.1');
    expect(canonicalModel('o4-mini-2025-04-16', p)).toBe('o4-mini');
    expect(costOf({ input: 1_000_000, output: 0, cache_write: 0, cache_write_1h: 0, cache_read: 0 }, 'gpt-5', p)).toBeCloseTo(1.25, 6);
  });

  it('a rollout without token counts still yields prompts and tools, labelled partial', () => {
    const f = rollout([
      { timestamp: '2026-09-26T10:00:00.000Z', type: 'session_meta', payload: { id: 'cdx-2', cwd: 'C:/Users/dev/app' } },
      { timestamp: '2026-09-26T10:00:02.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'hello' } },
      { timestamp: '2026-09-26T10:00:03.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'hi' } },
    ]);
    const t = parseTranscriptFile(f);
    expect(t.prompts.length).toBe(1);
    expect(t.cost).toBe(0);
    expect(t.cost_confidence).toBe('partial');
  });
});
