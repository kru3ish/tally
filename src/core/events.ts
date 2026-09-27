/* The normalised event stream: what every engine downstream of an adapter reads.

   Adapters record raw hook events in Claude Code's vocabulary (`src/store/events.ts`, kept unchanged for compatibility)
   and, where the agent exposes them, transcripts with token usage. This module projects both into one vendor-neutral
   stream. Nothing here branches on which agent produced an event: the adapter already said who it was (`agent`), the
   model string says which model (`model`), and the rest is what happened. Raw provenance is kept on every event
   (`source`) so a claim on a receipt can be traced back to the line that produced it. */
import type { TallyEvent } from '../store/events.js';
import type { Transcript } from '../transcript/parse.js';
import type { Usage } from '../cost/pricing.js';

export type NormalizedEventType =
  | 'session_started'
  | 'session_finished'
  | 'user_prompt'
  | 'agent_message'
  | 'file_read'
  | 'file_edit'
  | 'file_create'
  | 'file_delete'
  | 'command_started'
  | 'command_finished'
  | 'test_started'
  | 'test_finished'
  | 'tool_call'
  | 'tool_result'
  | 'git_commit'
  | 'git_push'
  | 'pull_request_created'
  | 'subagent_started'
  | 'subagent_finished'
  | 'context_compaction'
  | 'error'
  | 'permission_request'
  | 'model_usage';

/* The harness that drove the session. Not the model: a product can run many models and a model can run under many products. */
export interface AgentIdentity {
  product: string;
  version?: string;
}

/* The model behind a turn, resolved from the model string the agent reported. */
export interface ModelIdentity {
  provider: 'anthropic' | 'openai' | 'google' | 'local' | 'unknown';
  family: string;
  model: string;
}

export interface NormalizedEvent {
  eventId: string;
  sessionId: string;
  timestamp: string;
  type: NormalizedEventType;
  agent: AgentIdentity;
  model?: ModelIdentity;
  tool?: string;
  repository?: string;
  branch?: string;
  file?: string;
  command?: string;
  exitCode?: number;
  /* known only when the source reports it; never inferred */
  duration_ms?: number;
  tokens?: Usage;
  cost_usd?: number;
  metadata: Record<string, unknown>;
  /* where this came from: the adapter, the raw event type, and its index in the raw store (or -1 for the transcript) */
  source: { adapter: string; rawType: string; index: number };
}

const TEST_CMD_RE = /\b((npm|pnpm|yarn|bun)\s+(run\s+)?test|pytest|go test|cargo test|make test|vitest|jest|mocha|tape|node --test)\b/;

export function modelIdentity(model: string | undefined): ModelIdentity | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  if (m.startsWith('local:')) return { provider: 'local', family: m.slice(6).split(/[:\-@]/)[0] ?? m, model };
  if (/claude|opus|sonnet|haiku|fable|mythos/.test(m)) return { provider: 'anthropic', family: 'claude', model };
  if (/^(gpt|o\d|codex|chatgpt|text-)/.test(m)) return { provider: 'openai', family: m.startsWith('o') && !m.startsWith('op') ? 'o-series' : 'gpt', model };
  if (/gemini|palm|bison/.test(m)) return { provider: 'google', family: 'gemini', model };
  return { provider: 'unknown', family: m.split(/[:\-@/]/)[0] ?? m, model };
}

function fileFrom(input: Record<string, unknown> | undefined): string | undefined {
  const f = input?.file_path ?? input?.path ?? input?.notebook_path;
  return typeof f === 'string' ? f : undefined;
}

function commandFrom(input: Record<string, unknown> | undefined): string | undefined {
  const c = input?.command;
  return typeof c === 'string' ? c : undefined;
}

function shipType(kind: unknown): NormalizedEventType {
  const k = String(kind ?? '');
  if (k === 'pr' || k === 'pull_request') return 'pull_request_created';
  if (k === 'commit') return 'git_commit';
  return 'git_push';
}

/* Project a session's raw events (and its transcript, when there is one) into the normalised stream, in time order. */
export function normalizeSession(raw: TallyEvent[], transcript?: Transcript | null): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  const start = raw.find((e) => e.type === 'session_start');
  const agent: AgentIdentity = { product: String(start?.data.agent ?? 'claude-code'), version: typeof start?.data.version === 'string' ? start.data.version : undefined };
  const sessionId = raw[0]?.session ?? transcript?.sessionId ?? 'unknown';
  const repository = start?.cwd ?? raw.find((e) => e.cwd)?.cwd ?? transcript?.cwd;
  const branch = typeof start?.data.branch === 'string' ? start.data.branch : transcript?.gitBranch;
  let model = modelIdentity(typeof start?.data.model === 'string' ? start.data.model : transcript?.models[0]);
  let n = 0;
  const push = (e: Omit<NormalizedEvent, 'eventId' | 'sessionId' | 'agent' | 'repository' | 'branch' | 'model'> & { model?: ModelIdentity }): void => {
    out.push({ eventId: `${sessionId.slice(0, 8)}-${n++}`, sessionId, agent, repository, branch, model: e.model ?? model, ...e });
  };

  raw.forEach((e, index) => {
    const src = { adapter: agent.product, rawType: e.type, index };
    const d = e.data;
    switch (e.type) {
      case 'session_start':
        push({ timestamp: e.ts, type: 'session_started', metadata: { source: d.source, loaded: d.loaded, git_head: d.git_head, transcript_path: d.transcript_path }, source: src });
        break;
      case 'session_end':
        push({ timestamp: e.ts, type: 'session_finished', metadata: { reason: d.reason }, source: src });
        break;
      case 'prompt':
        push({ timestamp: e.ts, type: 'user_prompt', metadata: { text: d.prompt, turn: d.turn }, source: src });
        break;
      case 'stop':
        push({ timestamp: e.ts, type: 'agent_message', metadata: { text: d.last_assistant_message }, source: src });
        break;
      case 'pre_compact':
        push({ timestamp: e.ts, type: 'context_compaction', metadata: { trigger: d.trigger }, source: src });
        break;
      case 'permission':
        push({ timestamp: e.ts, type: 'permission_request', metadata: { notification_type: d.notification_type, message: d.message }, source: src });
        break;
      case 'hard_stop_denied':
        push({ timestamp: e.ts, type: 'permission_request', tool: String(d.tool_name ?? ''), metadata: { denied: true, reason: 'hard stop', tool_use_id: d.tool_use_id }, source: src });
        break;
      case 'ship':
        push({ timestamp: e.ts, type: shipType(d.kind), command: typeof d.command === 'string' ? d.command : undefined, metadata: { kind: d.kind, url: d.url }, source: src });
        break;
      case 'pre_tool': {
        const tool = String(d.tool_name ?? '');
        const input = d.tool_input as Record<string, unknown> | undefined;
        const sub = typeof d.agent === 'string' && d.agent ? { subagent: d.agent } : {};
        const id = { tool_use_id: d.tool_use_id, ...sub };
        if (tool === 'Bash') {
          const command = commandFrom(input) ?? '';
          push({ timestamp: e.ts, type: 'command_started', tool, command, metadata: id, source: src });
          if (TEST_CMD_RE.test(command)) push({ timestamp: e.ts, type: 'test_started', tool, command, metadata: id, source: src });
        } else if (tool === 'Read') push({ timestamp: e.ts, type: 'file_read', tool, file: fileFrom(input), metadata: id, source: src });
        else if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') push({ timestamp: e.ts, type: 'file_edit', tool, file: fileFrom(input), metadata: id, source: src });
        else if (tool === 'Write') push({ timestamp: e.ts, type: 'file_create', tool, file: fileFrom(input), metadata: { ...id, note: 'Write: creates or overwrites; whether the file existed is not observed' }, source: src });
        else push({ timestamp: e.ts, type: 'tool_call', tool, metadata: { ...id, input: input ?? {} }, source: src });
        break;
      }
      case 'post_tool': {
        const tool = String(d.tool_name ?? '');
        const input = d.tool_input as Record<string, unknown> | undefined;
        const isError = d.is_error === true;
        const meta = { tool_use_id: d.tool_use_id, is_error: isError, response_chars: d.response_chars, response_head: d.response_head };
        if (tool === 'Bash') {
          const command = commandFrom(input) ?? '';
          push({ timestamp: e.ts, type: 'command_finished', tool, command, metadata: meta, source: src });
          if (TEST_CMD_RE.test(command)) push({ timestamp: e.ts, type: 'test_finished', tool, command, metadata: { ...meta, passed: !isError }, source: src });
        } else if (tool === 'Read' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write' || tool === 'NotebookEdit') {
          if (isError) push({ timestamp: e.ts, type: 'error', tool, file: fileFrom(input), metadata: meta, source: src });
        } else push({ timestamp: e.ts, type: 'tool_result', tool, metadata: meta, source: src });
        if (isError && tool === 'Bash') push({ timestamp: e.ts, type: 'error', tool, command: commandFrom(input), metadata: { tool_use_id: d.tool_use_id }, source: src });
        break;
      }
      default:
        /* coach, task, judge, inject, apply, skip, mute, note, budget_approved, dispute: Tally's own bookkeeping, not agent activity */
        break;
    }
  });

  if (transcript) {
    for (const m of transcript.messages) {
      const mm = modelIdentity(m.model) ?? model;
      if (mm && (!model || mm.model !== model.model)) model = mm;
      push({ timestamp: m.ts, type: 'model_usage', model: mm, tokens: m.usage, cost_usd: m.cost, metadata: { turn: m.turn, phase: m.phase, subagent: m.agent !== 'main' ? m.agent : undefined, after_compaction: m.afterCompaction }, source: { adapter: agent.product, rawType: 'transcript:assistant', index: -1 } });
    }
    if (!raw.some((e) => e.type === 'pre_compact')) for (const c of transcript.compactions) push({ timestamp: c.ts, type: 'context_compaction', metadata: { turn: c.turn }, source: { adapter: agent.product, rawType: 'transcript:compaction', index: -1 } });
  }
  return out.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.eventId.localeCompare(b.eventId, undefined, { numeric: true }));
}

/* Counts every engine can rely on without knowing the agent. Missing observations are absent, not zero. */
export interface SessionCounts {
  prompts: number;
  agent_messages: number;
  files_read: number;
  files_edited: number;
  commands: number;
  failed_commands: number;
  test_runs: number;
  failed_test_runs: number;
  tool_calls: number;
  compactions: number;
  usage?: Usage;
  cost_usd?: number;
}

export function countEvents(events: NormalizedEvent[]): SessionCounts {
  const c: SessionCounts = { prompts: 0, agent_messages: 0, files_read: 0, files_edited: 0, commands: 0, failed_commands: 0, test_runs: 0, failed_test_runs: 0, tool_calls: 0, compactions: 0 };
  let usage: Usage | undefined;
  let cost = 0;
  let sawUsage = false;
  for (const e of events) {
    switch (e.type) {
      case 'user_prompt': c.prompts += 1; break;
      case 'agent_message': c.agent_messages += 1; break;
      case 'file_read': c.files_read += 1; break;
      case 'file_edit': case 'file_create': case 'file_delete': c.files_edited += 1; break;
      case 'command_finished': c.commands += 1; if (e.metadata.is_error) c.failed_commands += 1; break;
      case 'test_finished': c.test_runs += 1; if (e.metadata.passed === false) c.failed_test_runs += 1; break;
      case 'tool_call': c.tool_calls += 1; break;
      case 'context_compaction': c.compactions += 1; break;
      case 'model_usage':
        if (e.tokens) {
          sawUsage = true;
          usage = usage ? { input: usage.input + e.tokens.input, output: usage.output + e.tokens.output, cache_write: usage.cache_write + e.tokens.cache_write, cache_write_1h: (usage.cache_write_1h ?? 0) + (e.tokens.cache_write_1h ?? 0), cache_read: usage.cache_read + e.tokens.cache_read } : { ...e.tokens };
          cost += e.cost_usd ?? 0;
        }
        break;
      default: break;
    }
  }
  c.tool_calls += c.files_read + c.files_edited + c.commands;
  if (sawUsage) {
    c.usage = usage;
    c.cost_usd = cost;
  }
  return c;
}
