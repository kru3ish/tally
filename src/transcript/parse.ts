import fs from 'node:fs';
import path from 'node:path';
import { addUsage, canonicalModel, costOf, emptyUsage, loadPricing, type Pricing, type Usage } from '../cost/pricing.js';
import { isInternalCwd } from '../paths.js';

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  ts: string;
  agent: string;
  messageId: string;
  turn: number;
  phase: Phase;
  result?: { isError: boolean; chars: number; text: string };
}

export interface AssistantMessage {
  id: string;
  ts: string;
  model: string;
  usage: Usage;
  cost: number;
  agent: string;
  turn: number;
  phase: Phase;
  text: string;
  toolUseIds: string[];
  afterCompaction: boolean;
}

export interface Prompt {
  ts: string;
  text: string;
  turn: number;
}

export type Phase = 'explore' | 'build' | 'verify' | 'ship';

export interface Compaction {
  ts: string;
  turn: number;
}

export interface Transcript {
  sessionId: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  startedAt?: string;
  endedAt?: string;
  models: string[];
  prompts: Prompt[];
  messages: AssistantMessage[];
  toolCalls: ToolCall[];
  compactions: Compaction[];
  usage: Usage;
  cost: number;
  byModel: Record<string, { usage: Usage; cost: number; messages: number }>;
  byAgent: Record<string, { usage: Usage; cost: number; messages: number; toolCalls: number }>;
  byPhase: Record<Phase, { usage: Usage; cost: number; messages: number }>;
  firstTurnContextTokens: number;
  contextTokensNow: number;
  finalAssistantText: string;
  skills: Array<{ name: string; ts: string; turn: number; messageId: string }>;
  mcpCalls: Array<{ server: string; tool: string; ts: string; turn: number; messageId: string; isError: boolean }>;
  /* true when the transcript came from one of Tally's own headless runs; excluded from every stat */
  internal: boolean;
  entrypoint?: string;
  format: TranscriptFormat;
  cost_confidence: 'full' | 'partial';
}

export interface TranscriptFormat {
  version?: string;
  known: boolean;
  total_lines: number;
  unparseable_lines: number;
  unknown_types: string[];
}

/* Transcript layouts Tally has been verified against (Claude Code major.minor). */
export const KNOWN_FORMAT_VERSIONS = ['2.1'];
const KNOWN_LINE_TYPES = new Set(['assistant', 'user', 'system', 'attachment', 'permission-mode', 'mode', 'summary', 'progress', 'queue-operation', 'file-history-snapshot', 'custom-title', 'last-prompt', 'ai-title', 'pr-link', 'agent-name']);

export function isKnownFormatVersion(version: string | undefined): boolean {
  if (!version) return false;
  const mm = version.split('.').slice(0, 2).join('.');
  return KNOWN_FORMAT_VERSIONS.includes(mm);
}

interface RawLine {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  agentId?: string;
  timestamp?: string;
  cwd?: string;
  entrypoint?: string;
  version?: string;
  gitBranch?: string;
  sessionId?: string;
  isCompactSummary?: boolean;
  message?: {
    id?: string;
    model?: string;
    role?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
    };
  };
}

const TEST_RE = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(vitest|jest|pytest|py\.test|go test|cargo test|mocha|rspec|phpunit|mvn test|gradle test|dotnet test|make test)\b/;
const LINT_RE = /\b(eslint|ruff|flake8|pylint|tsc\b|prettier --check|golangci-lint|cargo clippy|mypy)\b/;
const SHIP_RE = /\bgit\s+push\b|\bgh\s+pr\s+(create|merge)\b|\bnpm\s+publish\b|\bgit\s+merge\b.*\bmain\b|\bcargo\s+publish\b|\btwine\s+upload\b/;

export function isTestCommand(cmd: string): boolean {
  return TEST_RE.test(cmd);
}
export function isLintCommand(cmd: string): boolean {
  return LINT_RE.test(cmd);
}
export function isShipCommand(cmd: string): boolean {
  return SHIP_RE.test(cmd);
}

export function readTranscriptLines(file: string): { lines: RawLine[]; unparseable: number; total: number } {
  if (!fs.existsSync(file)) return { lines: [], unparseable: 0, total: 0 };
  const out: RawLine[] = [];
  let unparseable = 0;
  let total = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    total += 1;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        unparseable += 1;
        continue;
      }
      out.push(parsed as RawLine);
    } catch {
      unparseable += 1;
    }
  }
  return { lines: out, unparseable, total };
}

export function parseTranscriptFile(file: string, pricing: Pricing = loadPricing()): Transcript {
  const main = readTranscriptLines(file);
  const lines = main.lines;
  let unparseable = main.unparseable;
  let total = main.total;
  const dir = file.replace(/\.jsonl$/, '');
  const subDir = path.join(dir, 'subagents');
  if (fs.existsSync(subDir)) {
    for (const f of fs.readdirSync(subDir).filter((x) => x.endsWith('.jsonl'))) {
      const agent = f.replace(/\.jsonl$/, '');
      const sub = readTranscriptLines(path.join(subDir, f));
      unparseable += sub.unparseable;
      total += sub.total;
      for (const l of sub.lines) {
        l.isSidechain = true;
        l.agentId ??= agent;
        lines.push(l);
      }
    }
  }
  lines.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
  return parseTranscript(lines, pricing, { unparseable, total });
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object' && (c as { type?: string }).type === 'text') return String((c as { text?: string }).text ?? '');
        return '';
      })
      .join('');
  }
  return '';
}

export function parseTranscript(lines: RawLine[], pricing: Pricing = loadPricing(), counts: { unparseable: number; total: number } = { unparseable: 0, total: lines.length }): Transcript {
  const unknownTypes = new Set<string>();
  const t: Transcript = {
    internal: false,
    format: { known: false, total_lines: counts.total, unparseable_lines: counts.unparseable, unknown_types: [] },
    cost_confidence: 'full',
    sessionId: '',
    models: [],
    prompts: [],
    messages: [],
    toolCalls: [],
    compactions: [],
    usage: emptyUsage(),
    cost: 0,
    byModel: {},
    byAgent: {},
    byPhase: {
      explore: { usage: emptyUsage(), cost: 0, messages: 0 },
      build: { usage: emptyUsage(), cost: 0, messages: 0 },
      verify: { usage: emptyUsage(), cost: 0, messages: 0 },
      ship: { usage: emptyUsage(), cost: 0, messages: 0 },
    },
    firstTurnContextTokens: 0,
    contextTokensNow: 0,
    finalAssistantText: '',
    skills: [],
    mcpCalls: [],
  };

  const seenMsg = new Map<string, AssistantMessage>();
  const callById = new Map<string, ToolCall>();
  let turn = 0;
  let phase: Phase = 'explore';
  let pendingCompaction = false;
  let lastAssistantText = '';
  let lastMainMessage: AssistantMessage | undefined;

  for (const l of lines) {
    if (!t.sessionId && l.sessionId) t.sessionId = l.sessionId;
    if (!t.cwd && l.cwd) t.cwd = l.cwd;
    if (!t.version && l.version) t.version = l.version;
    if (!t.entrypoint && l.entrypoint) t.entrypoint = l.entrypoint;
    if (l.type && !KNOWN_LINE_TYPES.has(l.type)) unknownTypes.add(l.type);
    if (!t.gitBranch && l.gitBranch) t.gitBranch = l.gitBranch;
    if (l.timestamp) {
      if (!t.startedAt || l.timestamp < t.startedAt) t.startedAt = l.timestamp;
      if (!t.endedAt || l.timestamp > t.endedAt) t.endedAt = l.timestamp;
    }
    const agent = l.isSidechain ? l.agentId ?? 'subagent' : 'main';

    if (l.isCompactSummary || (l.type === 'system' && l.subtype === 'compact_boundary')) {
      t.compactions.push({ ts: l.timestamp ?? '', turn });
      pendingCompaction = true;
      continue;
    }

    if (l.type === 'user' && l.message) {
      const content = l.message.content;
      const blocks = Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
      const results = blocks.filter((b) => b.type === 'tool_result');
      if (results.length) {
        for (const r of results) {
          const call = callById.get(String(r.tool_use_id));
          if (!call) continue;
          const text = textOf(r.content);
          call.result = { isError: !!r.is_error, chars: text.length, text: text.slice(0, 4000) };
        }
        continue;
      }
      if (l.isSidechain) continue;
      const text = textOf(content).trim();
      if (!text || text.startsWith('<command-name>') || text.startsWith('<local-command')) continue;
      turn += 1;
      t.prompts.push({ ts: l.timestamp ?? '', text, turn });
      continue;
    }

    if (l.type === 'assistant' && l.message) {
      const m = l.message;
      const id = m.id ?? l.uuid ?? String(Math.random());
      const content = Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [];
      const model = m.model ?? 'unknown';

      let msg = seenMsg.get(id);
      if (!msg) {
        const u = m.usage ?? {};
        const usage: Usage = {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cache_write: u.cache_creation_input_tokens ?? 0,
          cache_write_1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
          cache_read: u.cache_read_input_tokens ?? 0,
        };
        msg = {
          id,
          ts: l.timestamp ?? '',
          model,
          usage,
          cost: costOf(usage, model, pricing),
          agent,
          turn,
          phase,
          text: '',
          toolUseIds: [],
          afterCompaction: pendingCompaction && agent === 'main',
        };
        if (agent === 'main' && pendingCompaction) pendingCompaction = false;
        seenMsg.set(id, msg);
        t.messages.push(msg);
        if (!t.models.includes(model)) t.models.push(model);
        t.usage = addUsage(t.usage, usage);
        t.cost += msg.cost;
        const bm = (t.byModel[canonicalModel(model, pricing)] ??= { usage: emptyUsage(), cost: 0, messages: 0 });
        bm.usage = addUsage(bm.usage, usage);
        bm.cost += msg.cost;
        bm.messages += 1;
        const ba = (t.byAgent[agent] ??= { usage: emptyUsage(), cost: 0, messages: 0, toolCalls: 0 });
        ba.usage = addUsage(ba.usage, usage);
        ba.cost += msg.cost;
        ba.messages += 1;
        const bp = t.byPhase[phase];
        bp.usage = addUsage(bp.usage, usage);
        bp.cost += msg.cost;
        bp.messages += 1;
        if (agent === 'main') {
          const ctx = usage.input + usage.cache_read + usage.cache_write;
          if (!t.firstTurnContextTokens) t.firstTurnContextTokens = ctx;
          lastMainMessage = msg;
        }
      }

      for (const b of content) {
        if (b.type === 'text') {
          const txt = String(b.text ?? '');
          msg.text += txt;
          if (agent === 'main' && txt.trim()) lastAssistantText = txt;
        } else if (b.type === 'tool_use') {
          const name = String(b.name ?? '');
          const input = (b.input ?? {}) as Record<string, unknown>;
          const cmd = typeof input.command === 'string' ? input.command : '';
          if (agent === 'main') {
            if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') {
              if (phase === 'explore') phase = 'build';
            } else if (name === 'Bash' && cmd) {
              if (isShipCommand(cmd)) phase = 'ship';
              else if ((isTestCommand(cmd) || isLintCommand(cmd)) && phase === 'build') phase = 'verify';
            }
          }
          const call: ToolCall = {
            id: String(b.id ?? ''),
            name,
            input,
            ts: l.timestamp ?? '',
            agent,
            messageId: id,
            turn,
            phase,
            result: undefined,
          };
          msg.toolUseIds.push(call.id);
          callById.set(call.id, call);
          t.toolCalls.push(call);
          const ba = (t.byAgent[agent] ??= { usage: emptyUsage(), cost: 0, messages: 0, toolCalls: 0 });
          ba.toolCalls += 1;
          if (name === 'Skill') {
            t.skills.push({ name: String(input.skill ?? input.name ?? ''), ts: call.ts, turn, messageId: id });
          } else if (name.startsWith('mcp__')) {
            const parts = name.split('__');
            t.mcpCalls.push({ server: parts[1] ?? '', tool: parts.slice(2).join('__'), ts: call.ts, turn, messageId: id, isError: false });
          }
        }
      }
    }
  }

  for (const mc of t.mcpCalls) {
    const call = t.toolCalls.find((c) => c.messageId === mc.messageId && c.name === `mcp__${mc.server}__${mc.tool}`);
    if (call?.result?.isError) mc.isError = true;
  }

  if (lastMainMessage) {
    t.contextTokensNow = lastMainMessage.usage.input + lastMainMessage.usage.cache_read + lastMainMessage.usage.cache_write;
  }
  t.finalAssistantText = lastAssistantText;
  t.internal = isInternalCwd(t.cwd) || t.entrypoint === 'tally';
  t.format.version = t.version;
  t.format.known = isKnownFormatVersion(t.version);
  t.format.unknown_types = [...unknownTypes].sort();
  const assistantWithoutUsage = lines.filter((l) => l.type === 'assistant' && l.message && !l.message.usage).length;
  t.cost_confidence = counts.unparseable > 0 || !t.format.known || assistantWithoutUsage > 0 ? 'partial' : 'full';
  return t;
}

export function turnOf(t: Transcript, ts: string): number {
  let turn = 0;
  for (const p of t.prompts) if (p.ts <= ts) turn = p.turn;
  return turn;
}
