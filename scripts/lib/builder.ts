/* Shared transcript + hook-event fixture builder. Produces the same line shapes Claude Code 2.1.x writes. */
import fs from 'node:fs';
import path from 'node:path';

export type Line = Record<string, unknown>;
export type Tool = { name: string; input: Record<string, unknown> };

class Clock {
  t: number;
  constructor(iso: string) {
    this.t = Date.parse(iso);
  }
  tick(s: number): string {
    this.t += s * 1000;
    return new Date(this.t).toISOString();
  }
  now(): string {
    return new Date(this.t).toISOString();
  }
}

export interface BuilderOptions {
  session: string;
  cwd: string;
  transcriptPath?: string;
  start?: string;
  branch?: string;
  model?: string;
  loaded?: { mcp: string[]; skills: string[]; plugins: string[] };
  gitHead?: string;
  initialContext?: number;
}

export class Builder {
  lines: Line[] = [];
  events: Line[] = [];
  clock: Clock;
  lastUuid: string | null = null;
  n = 0;
  msgN = 0;
  turnN = 0;
  ctx: number;
  cacheWriteNext: number;
  readonly session: string;
  readonly cwd: string;
  readonly transcriptPath: string;
  readonly branch: string;
  readonly model: string;
  readonly loaded: { mcp: string[]; skills: string[]; plugins: string[] };
  readonly gitHead: string;

  constructor(o: BuilderOptions) {
    this.session = o.session;
    this.cwd = o.cwd;
    this.transcriptPath = o.transcriptPath ?? `${o.cwd}\\.claude-transcript\\${o.session}.jsonl`;
    this.clock = new Clock(o.start ?? '2026-09-10T14:00:00.000Z');
    this.branch = o.branch ?? 'feature/work';
    this.model = o.model ?? 'claude-opus-5';
    this.loaded = o.loaded ?? { mcp: ['github'], skills: ['superpowers:test-driven-development'], plugins: ['superpowers'] };
    this.gitHead = o.gitHead ?? 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    this.ctx = o.initialContext ?? 28000;
    this.cacheWriteNext = this.ctx;
  }

  uuid(): string {
    this.n += 1;
    return `00000000-0000-4000-8000-${String(this.n).padStart(12, '0')}`;
  }

  base(extra: Line, agent?: string): Line {
    const uuid = this.uuid();
    const l: Line = {
      parentUuid: this.lastUuid,
      isSidechain: !!agent,
      ...(agent ? { agentId: agent } : {}),
      userType: 'external',
      entrypoint: 'cli',
      cwd: this.cwd,
      sessionId: this.session,
      version: '2.1.268',
      gitBranch: this.branch,
      uuid,
      timestamp: this.clock.now(),
      ...extra,
    };
    this.lastUuid = uuid;
    return l;
  }

  event(type: string, data: Line): void {
    this.events.push({ ts: this.clock.now(), type, session: this.session, cwd: this.cwd, data });
  }

  sessionStart(): void {
    this.lines.push({ type: 'permission-mode', permissionMode: 'default', sessionId: this.session });
    this.event('session_start', { source: 'startup', transcript_path: this.transcriptPath, model: this.model, loaded: this.loaded, git_head: this.gitHead });
  }

  prompt(text: string): void {
    this.turnN += 1;
    this.clock.tick(90);
    this.lines.push(this.base({ type: 'user', promptId: this.uuid(), message: { role: 'user', content: text } }));
    this.event('prompt', { prompt: text, turn: this.turnN });
  }

  assistant(opts: { model?: string; agent?: string; output?: number; text?: string; tools?: Tool[]; afterCompaction?: boolean }): string[] {
    this.clock.tick(25);
    this.msgN += 1;
    const id = `msg_${this.session.slice(0, 6)}${String(this.msgN).padStart(6, '0')}`;
    const model = opts.model ?? this.model;
    const output = opts.output ?? 300;
    const isMain = !opts.agent;
    let usage: Line;
    if (isMain) {
      const cacheWrite = opts.afterCompaction ? this.ctx : this.cacheWriteNext;
      const cacheRead = opts.afterCompaction ? 0 : this.ctx - this.cacheWriteNext;
      usage = {
        output_tokens: output,
        input_tokens: 3,
        cache_creation_input_tokens: cacheWrite,
        cache_read_input_tokens: Math.max(0, cacheRead),
        cache_creation: { ephemeral_1h_input_tokens: cacheWrite, ephemeral_5m_input_tokens: 0 },
        service_tier: 'standard',
      };
      this.ctx += output + 900;
      this.cacheWriteNext = output + 900;
    } else {
      usage = {
        input_tokens: 5,
        output_tokens: output,
        cache_creation_input_tokens: 1200,
        cache_read_input_tokens: 9000,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 1200 },
        service_tier: 'standard',
      };
    }
    const ids: string[] = [];
    const blocks: Line[] = [];
    if (opts.text) blocks.push({ type: 'text', text: opts.text });
    for (const t of opts.tools ?? []) {
      const tid = `toolu_${this.session.slice(0, 6)}${String(this.n + blocks.length).padStart(6, '0')}`;
      ids.push(tid);
      blocks.push({ type: 'tool_use', id: tid, name: t.name, input: t.input });
    }
    if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
    for (const b of blocks) {
      this.lines.push(this.base({ type: 'assistant', requestId: `req_${this.msgN}`, message: { model, id, type: 'message', role: 'assistant', content: [b], stop_reason: ids.length ? 'tool_use' : 'end_turn', usage } }, opts.agent));
    }
    for (let i = 0; i < ids.length; i++) {
      const t = opts.tools![i]!;
      this.event('pre_tool', { tool_name: t.name, tool_input: t.input, tool_use_id: ids[i], agent: opts.agent ?? null });
    }
    return ids;
  }

  result(toolUseId: string, tool: Tool, text: string, isError = false, agent?: string): void {
    this.clock.tick(isError ? 40 : 10);
    this.lines.push(this.base({ type: 'user', message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content: text, ...(isError ? { is_error: true } : {}) }] } }, agent));
    this.event('post_tool', { tool_name: tool.name, tool_input: tool.input, tool_use_id: toolUseId, is_error: isError, response_chars: text.length, response_head: text.slice(0, 300), agent: agent ?? null });
  }

  call(tool: Tool, resultText: string, opts: { isError?: boolean; output?: number; text?: string; agent?: string; model?: string; afterCompaction?: boolean } = {}): void {
    const [id] = this.assistant({ tools: [tool], output: opts.output, text: opts.text, agent: opts.agent, model: opts.model, afterCompaction: opts.afterCompaction });
    this.result(id!, tool, resultText, opts.isError, opts.agent);
  }

  say(text: string, output = 120): void {
    this.assistant({ text, output });
  }

  stop(text: string): void {
    this.clock.tick(2);
    this.event('stop', { last_assistant_message: text.slice(0, 500) });
  }

  ship(command: string, resultText: string, kind: 'push' | 'pr' = 'push', url?: string): void {
    this.call({ name: 'Bash', input: { command, description: kind === 'push' ? 'Push branch' : 'Open PR' } }, resultText, { output: 90 });
    this.events.push({ ts: this.clock.now(), type: 'ship', session: this.session, cwd: this.cwd, data: { kind, command, ...(url ? { url } : {}) } });
  }

  compact(): void {
    this.clock.tick(30);
    this.event('pre_compact', { trigger: 'auto', context_tokens: this.ctx });
    this.lines.push(this.base({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. Summary: …' } }));
    this.ctx = 18000;
    this.cacheWriteNext = 18000;
  }

  end(): void {
    this.clock.tick(10);
    this.event('session_end', { reason: 'prompt_input_exit', transcript_path: this.transcriptPath });
  }

  read(file: string, body: string, opts: { output?: number } = {}): void {
    this.call({ name: 'Read', input: { file_path: `${this.cwd}\\${file.replace(/\//g, '\\')}` } }, body, { output: opts.output ?? 70 });
  }

  write(file: string, content: string, output = 400): void {
    this.call({ name: 'Write', input: { file_path: `${this.cwd}\\${file.replace(/\//g, '\\')}`, content } }, 'File created successfully', { output });
  }

  edit(file: string, oldS: string, newS: string, output = 200): void {
    this.call({ name: 'Edit', input: { file_path: `${this.cwd}\\${file.replace(/\//g, '\\')}`, old_string: oldS, new_string: newS } }, 'The file has been updated.', { output });
  }

  bash(command: string, out: string, opts: { isError?: boolean; output?: number; description?: string } = {}): void {
    this.call({ name: 'Bash', input: { command, description: opts.description ?? command } }, out, { isError: opts.isError, output: opts.output ?? 130 });
  }

  writeTo(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'transcript.jsonl'), this.lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'events.jsonl'), this.events.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
}
