/* Agent adapters: Tally's hooks, rules, Judge and Coach speak Claude Code's hook vocabulary (SessionStart,
   UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd; tool_name Bash / Edit / Write / Read with
   tool_input.command / file_path). Other coding agents expose the same lifecycle under other names and shapes, so
   one adapter per agent maps its events and payloads onto that vocabulary on the way in and formats Tally's answer
   (context, deny, block) on the way out. The hook script takes `--agent <id>`; `tally install --agent <id>` writes
   the agent's hook file. Verified against each agent's hook documentation on 2026-09-26 (docs/PLATFORM_NOTES.md). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type AgentId = 'claude-code' | 'codex' | 'gemini' | 'cursor';
export const AGENT_IDS: AgentId[] = ['claude-code', 'codex', 'gemini', 'cursor'];

export type CanonicalEvent = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'Stop' | 'PreCompact' | 'Notification' | 'SessionEnd' | 'Unknown';

/* Claude Code's hook input, which the rest of Tally consumes */
export interface CanonicalInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_use_id?: string;
  last_assistant_message?: string;
  reason?: string;
  source?: string;
  model?: string;
  message?: string;
  notification_type?: string;
  stop_hook_active?: boolean;
  [k: string]: unknown;
}

/* What Tally wants to say back, in Claude Code's terms */
export type CanonicalOutput =
  | { kind: 'context'; event: CanonicalEvent; text: string }
  | { kind: 'deny'; reason: string }
  | { kind: 'block'; reason: string };

export interface AgentAdapter {
  id: AgentId;
  label: string;
  /* the env var the agent sets with the session id in child processes, if any */
  sessionEnv?: string;
  /* the agent's event name → Tally's canonical event */
  event(name: string): CanonicalEvent;
  /* the agent's stdin JSON → canonical input */
  normalize(raw: Record<string, unknown>, agentEvent: string): CanonicalInput;
  /* Tally's answer → the agent's stdout JSON (null: say nothing) */
  output(out: CanonicalOutput): unknown;
  /* where the agent reads hooks from at user scope, and the hooks document Tally writes there */
  hooksFile(): string;
  /* merge Tally's hooks into an existing hooks document; returns the new document */
  writeHooks(existing: unknown, command: (event: CanonicalEvent) => string): unknown;
  /* remove Tally's hooks; returns the new document */
  removeHooks(existing: unknown): unknown;
  /* the agent's events Tally subscribes to (agent names) */
  subscribed: string[];
  /* where the agent keeps transcripts on disk, when known */
  transcriptRoots?: () => string[];
}

const ALL_CANONICAL: CanonicalEvent[] = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'PreCompact', 'Notification', 'SessionEnd'];

function home(): string {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function isTally(cmd: unknown): boolean {
  return typeof cmd === 'string' && /hook\.js["']?\s|tally/.test(cmd) && /--agent|tally/.test(cmd);
}

/* ---------- Claude Code: identity ---------- */
const claudeCode: AgentAdapter = {
  id: 'claude-code',
  label: 'Claude Code',
  sessionEnv: 'CLAUDE_SESSION_ID',
  subscribed: ALL_CANONICAL,
  event: (name) => (ALL_CANONICAL.includes(name as CanonicalEvent) ? (name as CanonicalEvent) : 'Unknown'),
  normalize: (raw) => raw as CanonicalInput,
  output(out) {
    if (out.kind === 'context') return { hookSpecificOutput: { hookEventName: out.event, additionalContext: out.text } };
    if (out.kind === 'deny') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: out.reason } };
    return { decision: 'block', reason: out.reason };
  },
  hooksFile: () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home(), '.claude'), 'settings.json'),
  writeHooks: (existing) => existing /* Claude Code install lives in src/install/install.ts */,
  removeHooks: (existing) => existing,
  transcriptRoots: () => [path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home(), '.claude'), 'projects')],
};

/* ---------- Codex CLI: same schema as Claude Code, hooks.json at ~/.codex, apply_patch for edits ---------- */
function codexTool(raw: Record<string, unknown>): { tool_name?: string; tool_input?: Record<string, unknown> } {
  const name = typeof raw.tool_name === 'string' ? raw.tool_name : undefined;
  const input = asRecord(raw.tool_input);
  if (name === 'apply_patch') {
    /* the patch names its files: "*** Update File: path" / "*** Add File: path" */
    const patch = typeof input.input === 'string' ? input.input : typeof input.patch === 'string' ? input.patch : JSON.stringify(input);
    const m = /\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(patch);
    return { tool_name: /\*\*\* Add File/.test(patch) && !/\*\*\* Update File/.test(patch) ? 'Write' : 'Edit', tool_input: { file_path: m?.[1]?.trim() ?? '', patch: patch.slice(0, 600) } };
  }
  if (name === 'shell' || name === 'exec_command' || name === 'local_shell') {
    const cmd = Array.isArray(input.command) ? (input.command as unknown[]).map(String).join(' ') : typeof input.cmd === 'string' ? input.cmd : input.command;
    return { tool_name: 'Bash', tool_input: { ...input, command: typeof cmd === 'string' ? cmd : String(cmd ?? '') } };
  }
  return { tool_name: name, tool_input: input };
}

const codex: AgentAdapter = {
  id: 'codex',
  label: 'Codex CLI',
  subscribed: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PreCompact', 'SessionEnd'],
  event: (name) => (ALL_CANONICAL.includes(name as CanonicalEvent) ? (name as CanonicalEvent) : 'Unknown'),
  normalize: (raw) => ({ ...raw, ...codexTool(raw) }) as CanonicalInput,
  output(out) {
    if (out.kind === 'context') return { hookSpecificOutput: { hookEventName: out.event, additionalContext: out.text } };
    if (out.kind === 'deny') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: out.reason } };
    return { decision: 'block', reason: out.reason };
  },
  hooksFile: () => path.join(process.env.CODEX_HOME || path.join(home(), '.codex'), 'hooks.json'),
  writeHooks(existing, command) {
    const doc = asRecord(existing);
    const hooks = asRecord(doc.hooks);
    for (const ev of this.subscribed) {
      const groups = Array.isArray(hooks[ev]) ? (hooks[ev] as Array<Record<string, unknown>>) : [];
      const kept = groups.filter((g) => !(Array.isArray(g.hooks) && (g.hooks as Array<Record<string, unknown>>).some((h) => isTally(h.command))));
      kept.push({ hooks: [{ type: 'command', command: command(ev as CanonicalEvent), timeout: 5 }] });
      hooks[ev] = kept;
    }
    return { ...doc, hooks };
  },
  removeHooks(existing) {
    const doc = asRecord(existing);
    const hooks = asRecord(doc.hooks);
    for (const ev of Object.keys(hooks)) {
      const groups = Array.isArray(hooks[ev]) ? (hooks[ev] as Array<Record<string, unknown>>) : [];
      const kept = groups.filter((g) => !(Array.isArray(g.hooks) && (g.hooks as Array<Record<string, unknown>>).some((h) => isTally(h.command))));
      if (kept.length) hooks[ev] = kept;
      else delete hooks[ev];
    }
    return { ...doc, hooks };
  },
  transcriptRoots: () => [path.join(process.env.CODEX_HOME || path.join(home(), '.codex'), 'sessions')],
};

/* ---------- Gemini CLI: BeforeTool/AfterTool/BeforeAgent/AfterAgent, tools run_shell_command / write_file / replace ---------- */
const GEMINI_EVENTS: Record<string, CanonicalEvent> = { SessionStart: 'SessionStart', SessionEnd: 'SessionEnd', BeforeAgent: 'UserPromptSubmit', AfterAgent: 'Stop', BeforeTool: 'PreToolUse', AfterTool: 'PostToolUse', PreCompress: 'PreCompact', Notification: 'Notification' };
const GEMINI_TOOLS: Record<string, string> = { run_shell_command: 'Bash', write_file: 'Write', replace: 'Edit', edit: 'Edit', read_file: 'Read', read_many_files: 'Read', glob: 'Glob', grep_search: 'Grep', search_file_content: 'Grep', web_fetch: 'WebFetch', google_web_search: 'WebSearch' };

const gemini: AgentAdapter = {
  id: 'gemini',
  label: 'Gemini CLI',
  sessionEnv: 'GEMINI_SESSION_ID',
  subscribed: ['SessionStart', 'BeforeAgent', 'BeforeTool', 'AfterTool', 'AfterAgent', 'PreCompress', 'SessionEnd'],
  event: (name) => GEMINI_EVENTS[name] ?? 'Unknown',
  normalize(raw, agentEvent) {
    const name = typeof raw.tool_name === 'string' ? raw.tool_name : undefined;
    const out: CanonicalInput = { ...raw, hook_event_name: this.event(agentEvent) };
    if (name) out.tool_name = GEMINI_TOOLS[name] ?? (name.startsWith('mcp__') ? name : `mcp__gemini__${name}`);
    if (agentEvent === 'AfterAgent' && typeof raw.prompt_response === 'string') out.last_assistant_message = raw.prompt_response;
    return out;
  },
  output(out) {
    if (out.kind === 'context') return { hookSpecificOutput: { hookEventName: out.event, additionalContext: out.text } };
    if (out.kind === 'deny') return { decision: 'deny', reason: out.reason, systemMessage: out.reason };
    return { decision: 'block', reason: out.reason };
  },
  hooksFile: () => path.join(home(), '.gemini', 'settings.json'),
  writeHooks(existing, command) {
    const doc = asRecord(existing);
    const hooks = asRecord(doc.hooks);
    for (const ev of this.subscribed) {
      const groups = Array.isArray(hooks[ev]) ? (hooks[ev] as Array<Record<string, unknown>>) : [];
      const kept = groups.filter((g) => !(Array.isArray(g.hooks) && (g.hooks as Array<Record<string, unknown>>).some((h) => h.name === 'tally' || isTally(h.command))));
      kept.push({ matcher: '*', hooks: [{ name: 'tally', type: 'command', command: command(this.event(ev)), timeout: 5000 }] });
      hooks[ev] = kept;
    }
    return { ...doc, hooks };
  },
  removeHooks(existing) {
    const doc = asRecord(existing);
    const hooks = asRecord(doc.hooks);
    for (const ev of Object.keys(hooks)) {
      const groups = Array.isArray(hooks[ev]) ? (hooks[ev] as Array<Record<string, unknown>>) : [];
      const kept = groups.filter((g) => !(Array.isArray(g.hooks) && (g.hooks as Array<Record<string, unknown>>).some((h) => h.name === 'tally' || isTally(h.command))));
      if (kept.length) hooks[ev] = kept;
      else delete hooks[ev];
    }
    return { ...doc, hooks };
  },
};

/* ---------- Cursor: hooks.json v1, camelCase events, conversation_id, workspace_roots ---------- */
const CURSOR_EVENTS: Record<string, CanonicalEvent> = { sessionStart: 'SessionStart', sessionEnd: 'SessionEnd', beforeSubmitPrompt: 'UserPromptSubmit', preToolUse: 'PreToolUse', postToolUse: 'PostToolUse', postToolUseFailure: 'PostToolUseFailure', beforeShellExecution: 'PreToolUse', afterShellExecution: 'PostToolUse', afterFileEdit: 'PostToolUse', stop: 'Stop', preCompact: 'PreCompact' };

const cursor: AgentAdapter = {
  id: 'cursor',
  label: 'Cursor',
  subscribed: ['sessionStart', 'beforeSubmitPrompt', 'beforeShellExecution', 'afterShellExecution', 'afterFileEdit', 'preToolUse', 'postToolUse', 'stop', 'sessionEnd'],
  event: (name) => CURSOR_EVENTS[name] ?? 'Unknown',
  normalize(raw, agentEvent) {
    const roots = Array.isArray(raw.workspace_roots) ? (raw.workspace_roots as unknown[]).map(String) : [];
    const out: CanonicalInput = {
      ...raw,
      hook_event_name: this.event(agentEvent),
      session_id: typeof raw.conversation_id === 'string' ? raw.conversation_id : typeof raw.session_id === 'string' ? raw.session_id : undefined,
      cwd: typeof raw.cwd === 'string' ? raw.cwd : roots[0],
      transcript_path: typeof raw.transcript_path === 'string' ? raw.transcript_path : undefined,
    };
    if (agentEvent === 'beforeShellExecution' || agentEvent === 'afterShellExecution') {
      out.tool_name = 'Bash';
      out.tool_input = { command: String(raw.command ?? '') };
      if (agentEvent === 'afterShellExecution') out.tool_response = raw.output ?? raw.result ?? '';
    } else if (agentEvent === 'afterFileEdit') {
      out.tool_name = 'Edit';
      out.tool_input = { file_path: String(raw.file_path ?? ''), edits: raw.edits };
      out.tool_response = '';
    } else if (agentEvent === 'postToolUse') {
      out.tool_response = raw.tool_output;
    } else if (agentEvent === 'beforeSubmitPrompt') {
      out.prompt = typeof raw.prompt === 'string' ? raw.prompt : typeof raw.text === 'string' ? raw.text : '';
    } else if (agentEvent === 'stop') {
      out.stop_hook_active = typeof raw.loop_count === 'number' && raw.loop_count > 0;
    }
    return out;
  },
  output(out) {
    if (out.kind === 'context') return out.event === 'SessionStart' ? { additional_context: out.text } : { additional_context: out.text };
    if (out.kind === 'deny') return { permission: 'deny', user_message: out.reason, agent_message: out.reason };
    /* Cursor's stop hook continues the agent with a follow-up message instead of blocking */
    return { followup_message: out.reason };
  },
  hooksFile: () => path.join(home(), '.cursor', 'hooks.json'),
  writeHooks(existing, command) {
    const doc = asRecord(existing);
    const hooks = asRecord(doc.hooks);
    for (const ev of this.subscribed) {
      const list = Array.isArray(hooks[ev]) ? (hooks[ev] as Array<Record<string, unknown>>) : [];
      const kept = list.filter((h) => !isTally(h.command));
      kept.push({ type: 'command', command: command(this.event(ev)), timeout: 5 });
      hooks[ev] = kept;
    }
    return { version: 1, ...doc, hooks };
  },
  removeHooks(existing) {
    const doc = asRecord(existing);
    const hooks = asRecord(doc.hooks);
    for (const ev of Object.keys(hooks)) {
      const list = Array.isArray(hooks[ev]) ? (hooks[ev] as Array<Record<string, unknown>>) : [];
      const kept = list.filter((h) => !isTally(h.command));
      if (kept.length) hooks[ev] = kept;
      else delete hooks[ev];
    }
    return { ...doc, hooks };
  },
};

const ADAPTERS: Record<AgentId, AgentAdapter> = { 'claude-code': claudeCode, codex, gemini, cursor };

export function agent(id: string | undefined): AgentAdapter {
  return ADAPTERS[(id ?? 'claude-code') as AgentId] ?? claudeCode;
}

/* `--agent <id>` anywhere in argv, else TALLY_AGENT, else claude-code; returns the remaining argv too */
export function agentFromArgv(argv: string[]): { adapter: AgentAdapter; rest: string[] } {
  const rest: string[] = [];
  let id: string | undefined = process.env.TALLY_AGENT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--agent' && argv[i + 1]) {
      id = argv[++i];
      continue;
    }
    const m = /^--agent=(.+)$/.exec(a);
    if (m) {
      id = m[1];
      continue;
    }
    rest.push(a);
  }
  return { adapter: agent(id), rest };
}

/* the session id from whichever agent set one in the environment */
export function sessionFromEnv(): string | undefined {
  for (const a of Object.values(ADAPTERS)) if (a.sessionEnv && process.env[a.sessionEnv]) return process.env[a.sessionEnv];
  return undefined;
}

/* which agents have hook files on this machine */
export function detectAgents(): Array<{ id: AgentId; file: string; installed: boolean }> {
  return AGENT_IDS.filter((id) => id !== 'claude-code').map((id) => {
    const a = ADAPTERS[id];
    const file = a.hooksFile();
    let installed = false;
    if (fs.existsSync(file)) {
      try {
        installed = /--agent[ =]/.test(fs.readFileSync(file, 'utf8')) && /tally|hook\.js/.test(fs.readFileSync(file, 'utf8'));
      } catch {
        installed = false;
      }
    }
    return { id, file, installed };
  });
}
