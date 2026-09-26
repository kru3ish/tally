/* Codex CLI rollout files (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) → Tally's Transcript. Each line is
   {timestamp, type, payload}: session_meta (id, cwd, model_provider), turn_context (model), response_item (message,
   function_call, function_call_output, custom_tool_call), event_msg (user_message, agent_message, token_count,
   task_started, task_complete). Written from the public descriptions of the format (docs/PLATFORM_NOTES.md), read
   tolerantly: unknown line types are counted, token_count is taken from whichever of info.total_token_usage /
   total_token_usage / last_token_usage is present, and a file without token counts yields cost_confidence 'partial'. */
import fs from 'node:fs';
import path from 'node:path';
import { addUsage, canonicalModel, costOf, emptyUsage, loadPricing, type Pricing, type Usage } from '../cost/pricing.js';
import { isInternalCwd } from '../paths.js';
import type { Transcript, ToolCall, Phase } from './parse.js';

export function isCodexRollout(file: string): boolean {
  if (/rollout-.*\.jsonl$/i.test(path.basename(file))) return true;
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(400);
    const n = fs.readSync(fd, buf, 0, 400, 0);
    fs.closeSync(fd);
    return /"type"\s*:\s*"session_meta"/.test(buf.toString('utf8', 0, n));
  } catch {
    return false;
  }
}

interface Line {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function usageFrom(o: Record<string, unknown> | undefined): Usage | null {
  if (!o) return null;
  const input = num(o.input_tokens);
  const cached = num(o.cached_input_tokens ?? o.cache_read_input_tokens);
  const output = num(o.output_tokens) + num(o.reasoning_output_tokens);
  if (!input && !output) return null;
  return { input: Math.max(0, input - cached), output, cache_write: 0, cache_write_1h: 0, cache_read: cached };
}

function phaseOf(name: string, cmd: string): Phase {
  if (/git (push|commit)|gh pr|npm publish/.test(cmd)) return 'ship';
  if (/\b(test|vitest|jest|pytest|mocha|tape|lint|tsc)\b/.test(cmd)) return 'verify';
  if (name === 'Edit' || name === 'Write') return 'build';
  return 'explore';
}

export function parseCodexRollout(file: string, pricing: Pricing = loadPricing()): Transcript {
  const raw = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let unparseable = 0;
  const lines: Line[] = [];
  for (const l of raw) {
    try {
      lines.push(JSON.parse(l) as Line);
    } catch {
      unparseable += 1;
    }
  }
  const t: Transcript = {
    sessionId: path.basename(file).replace(/^rollout-|\.jsonl$/g, ''),
    models: [],
    prompts: [],
    messages: [],
    toolCalls: [],
    compactions: [],
    usage: emptyUsage(),
    cost: 0,
    byModel: {},
    byAgent: {},
    byPhase: { explore: { usage: emptyUsage(), cost: 0, messages: 0 }, build: { usage: emptyUsage(), cost: 0, messages: 0 }, verify: { usage: emptyUsage(), cost: 0, messages: 0 }, ship: { usage: emptyUsage(), cost: 0, messages: 0 } },
    firstTurnContextTokens: 0,
    contextTokensNow: 0,
    finalAssistantText: '',
    skills: [],
    mcpCalls: [],
    internal: false,
    entrypoint: 'codex',
    format: { unknownTypes: [], unparseable, total: raw.length } as unknown as Transcript['format'],
    cost_confidence: 'partial',
  };
  let model = 'gpt-5-codex';
  let turn = 0;
  let lastTotal: Usage | null = null;
  let sawTokens = false;
  const pending = new Map<string, ToolCall>();
  const unknown = new Set<string>();
  let lastPhase: Phase = 'explore';
  for (const l of lines) {
    const ts = l.timestamp ?? new Date().toISOString();
    const p = l.payload ?? {};
    switch (l.type) {
      case 'session_meta': {
        const id = (p.id ?? p.session_id) as string | undefined;
        if (id) t.sessionId = id;
        if (typeof p.cwd === 'string') t.cwd = p.cwd;
        if (typeof p.timestamp === 'string') t.startedAt = p.timestamp;
        if (typeof p.model === 'string') model = p.model;
        const git = p.git as { branch?: string } | undefined;
        if (git?.branch) t.gitBranch = git.branch;
        if (typeof p.cli_version === 'string') t.version = p.cli_version;
        break;
      }
      case 'turn_context': {
        if (typeof p.model === 'string') model = p.model;
        if (typeof p.cwd === 'string' && !t.cwd) t.cwd = p.cwd;
        break;
      }
      case 'response_item': {
        const kind = p.type as string | undefined;
        if (kind === 'message' && p.role === 'user') {
          const content = Array.isArray(p.content) ? (p.content as Array<{ type?: string; text?: string }>) : [];
          const text = content.map((c) => c.text ?? '').join('\n').trim();
          if (text && !/^<environment_context>|^# AGENTS\.md/.test(text)) {
            turn += 1;
            t.prompts.push({ ts, text: text.slice(0, 4000), turn });
          }
        } else if (kind === 'message' && p.role === 'assistant') {
          const content = Array.isArray(p.content) ? (p.content as Array<{ type?: string; text?: string }>) : [];
          const text = content.map((c) => c.text ?? '').join('\n');
          t.finalAssistantText = text;
          t.messages.push({ id: `${t.messages.length}`, ts, model, usage: emptyUsage(), cost: 0, agent: 'main', turn, phase: lastPhase, text: text.slice(0, 2000), toolUseIds: [], afterCompaction: false });
        } else if (kind === 'function_call' || kind === 'custom_tool_call' || kind === 'local_shell_call') {
          const name0 = String(p.name ?? (kind === 'local_shell_call' ? 'shell' : 'tool'));
          let input: Record<string, unknown> = {};
          try {
            input = typeof p.arguments === 'string' ? (JSON.parse(p.arguments) as Record<string, unknown>) : typeof p.input === 'string' ? { input: p.input } : (p.action as Record<string, unknown>) ?? {};
          } catch {
            input = { arguments: String(p.arguments) };
          }
          let name = name0;
          if (/^(shell|exec_command|local_shell|container\.exec)$/.test(name0)) {
            name = 'Bash';
            const cmd = Array.isArray(input.command) ? (input.command as unknown[]).map(String).join(' ') : (input.cmd ?? input.command);
            input = { ...input, command: typeof cmd === 'string' ? cmd : String(cmd ?? '') };
          } else if (name0 === 'apply_patch') {
            const patch = typeof input.input === 'string' ? input.input : String(input.patch ?? '');
            const m = /\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(patch);
            name = /\*\*\* Add File/.test(patch) && !/\*\*\* Update File/.test(patch) ? 'Write' : 'Edit';
            input = { file_path: m?.[1]?.trim() ?? '', patch: patch.slice(0, 600) };
          } else if (name0.startsWith('mcp__') || (typeof p.server === 'string' && p.server)) {
            const parts = name0.split('__');
            t.mcpCalls.push({ server: String(p.server ?? parts[1] ?? ''), tool: parts.slice(2).join('__') || name0, ts, turn, messageId: `${t.messages.length}`, isError: false });
          }
          const cmd = typeof input.command === 'string' ? input.command : '';
          lastPhase = phaseOf(name, cmd);
          const call: ToolCall = { id: String(p.call_id ?? p.id ?? `${t.toolCalls.length}`), name, input, ts, agent: 'main', messageId: `${t.messages.length}`, turn, phase: lastPhase };
          t.toolCalls.push(call);
          pending.set(call.id, call);
        } else if (kind === 'function_call_output' || kind === 'custom_tool_call_output' || kind === 'local_shell_call_output') {
          const call = pending.get(String(p.call_id ?? ''));
          const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '');
          let isError = /(^|\n)(Error|error:|exit code: [1-9]|exited with code [1-9]|Command failed)/.test(out.slice(0, 400));
          try {
            const j = JSON.parse(out) as { exit_code?: number; metadata?: { exit_code?: number } };
            const code = j.exit_code ?? j.metadata?.exit_code;
            if (typeof code === 'number') isError = code !== 0;
          } catch {
            /* plain text output */
          }
          if (call) call.result = { isError, chars: out.length, text: out.slice(0, 4000) };
        } else if (kind) unknown.add(`response_item:${kind}`);
        break;
      }
      case 'event_msg': {
        const kind = p.type as string | undefined;
        if (kind === 'token_count') {
          const info = (p.info as Record<string, unknown> | undefined) ?? p;
          const total = usageFrom((info.total_token_usage as Record<string, unknown>) ?? (p.total_token_usage as Record<string, unknown>));
          const last = usageFrom((info.last_token_usage as Record<string, unknown>) ?? (p.last_token_usage as Record<string, unknown>));
          const delta = last ?? (total && lastTotal ? { input: Math.max(0, total.input - lastTotal.input), output: Math.max(0, total.output - lastTotal.output), cache_write: 0, cache_write_1h: 0, cache_read: Math.max(0, total.cache_read - lastTotal.cache_read) } : total);
          if (total) lastTotal = total;
          if (delta && (delta.input || delta.output)) {
            sawTokens = true;
            const cost = costOf(delta, model, pricing);
            const msg = t.messages[t.messages.length - 1];
            if (msg) {
              msg.usage = addUsage(msg.usage, delta);
              msg.cost += cost;
            } else t.messages.push({ id: `${t.messages.length}`, ts, model, usage: delta, cost, agent: 'main', turn, phase: lastPhase, text: '', toolUseIds: [], afterCompaction: false });
            t.usage = addUsage(t.usage, delta);
            t.cost += cost;
            const cm = canonicalModel(model, pricing);
            const bm = (t.byModel[cm] ??= { usage: emptyUsage(), cost: 0, messages: 0 });
            bm.usage = addUsage(bm.usage, delta);
            bm.cost += cost;
            bm.messages += 1;
            const ph = t.byPhase[lastPhase];
            ph.usage = addUsage(ph.usage, delta);
            ph.cost += cost;
            ph.messages += 1;
            if (!t.firstTurnContextTokens) t.firstTurnContextTokens = delta.input + delta.cache_read;
            t.contextTokensNow = delta.input + delta.cache_read + delta.output;
            if (!t.models.includes(cm)) t.models.push(cm);
          }
          const win = num(info.model_context_window);
          if (win && t.contextTokensNow > win) t.contextTokensNow = win;
        } else if (kind === 'user_message' && typeof p.message === 'string' && !t.prompts.some((q) => q.text === p.message)) {
          turn += 1;
          t.prompts.push({ ts, text: String(p.message).slice(0, 4000), turn });
        } else if (kind === 'agent_message' && typeof p.message === 'string') {
          t.finalAssistantText = p.message;
        } else if (kind && !/^(task_started|task_complete|item_completed|item_started|turn_diff|exec_command_begin|exec_command_end|agent_reasoning|reasoning|warning|error)$/.test(kind)) unknown.add(`event_msg:${kind}`);
        break;
      }
      case 'compacted': {
        t.compactions.push({ ts, turn } as unknown as Transcript['compactions'][number]);
        break;
      }
      default:
        if (l.type) unknown.add(l.type);
    }
    t.endedAt = ts;
  }
  t.byAgent.main = { usage: t.usage, cost: t.cost, messages: t.messages.length, toolCalls: t.toolCalls.length };
  t.cost_confidence = sawTokens ? 'full' : 'partial';
  t.internal = isInternalCwd(t.cwd);
  (t.format as unknown as { unknownTypes: string[] }).unknownTypes = [...unknown];
  return t;
}
