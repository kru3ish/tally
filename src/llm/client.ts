import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { appendLine, tallyHome, log } from '../paths.js';
import { canonicalModel, type Usage } from '../cost/pricing.js';

export interface LlmRequest {
  kind: 'intake' | 'judge' | 'coach';
  model: string;
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  timeoutMs?: number;
}

export interface LlmResult<T> {
  data: T;
  usage: Usage;
  cost_usd: number;
  model: string;
  duration_ms: number;
}

export interface LlmClient {
  complete<T>(req: LlmRequest): Promise<LlmResult<T>>;
}

export function tallySpendFile(): string {
  return path.join(tallyHome(), 'tally-spend.jsonl');
}

export function recordTallySpend(entry: { kind: string; model: string; cost_usd: number; usage: Usage; session?: string }): void {
  appendLine(tallySpendFile(), JSON.stringify({ ts: new Date().toISOString(), ...entry }));
}

interface CliOutput {
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  is_error?: boolean;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation?: { ephemeral_1h_input_tokens?: number };
  };
  modelUsage?: Record<string, { canonicalModel?: string }>;
}

export class ClaudeCli implements LlmClient {
  constructor(private readonly opts: { session?: string; claudeBin?: string } = {}) {}

  async complete<T>(req: LlmRequest): Promise<LlmResult<T>> {
    const started = Date.now();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-llm-'));
    const args = [
      '-p',
      req.prompt,
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(req.schema),
      '--model',
      req.model,
      '--system-prompt',
      req.system,
      '--max-turns',
      '1',
      '--tools',
      '',
      '--no-session-persistence',
      '--setting-sources',
      '',
      '--strict-mcp-config',
    ];
    const bin = this.opts.claudeBin ?? process.env.TALLY_CLAUDE_BIN ?? 'claude';
    const out = await runProcess(bin, args, { cwd, timeoutMs: req.timeoutMs ?? 240000 });
    fs.rmSync(cwd, { recursive: true, force: true });
    let parsed: CliOutput;
    try {
      parsed = JSON.parse(out.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop() ?? '{}') as CliOutput;
    } catch {
      throw new Error(`claude -p returned non-JSON output: ${out.stdout.slice(0, 300)} ${out.stderr.slice(0, 300)}`);
    }
    if (parsed.is_error) throw new Error(`claude -p error: ${parsed.result ?? out.stderr.slice(0, 300)}`);
    let data = parsed.structured_output as T | undefined;
    if (data === undefined && typeof parsed.result === 'string') {
      try {
        data = JSON.parse(parsed.result) as T;
      } catch {
        throw new Error('claude -p returned no structured output');
      }
    }
    if (data === undefined) throw new Error('claude -p returned no structured output');
    const u = parsed.usage ?? {};
    const usage: Usage = {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cache_write: u.cache_creation_input_tokens ?? 0,
      cache_write_1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      cache_read: u.cache_read_input_tokens ?? 0,
    };
    const modelKey = Object.keys(parsed.modelUsage ?? {})[0];
    const model = canonicalModel(modelKey ?? req.model);
    const cost_usd = parsed.total_cost_usd ?? 0;
    recordTallySpend({ kind: req.kind, model, cost_usd, usage, session: this.opts.session });
    log(`llm ${req.kind} model=${model} cost=${cost_usd.toFixed(4)} ms=${Date.now() - started}`);
    return { data, usage, cost_usd, model, duration_ms: Date.now() - started };
  }
}

export type StubResponder = (req: LlmRequest) => unknown;

export class StubLlm implements LlmClient {
  calls: LlmRequest[] = [];
  constructor(private readonly responders: Partial<Record<LlmRequest['kind'], StubResponder>>, private readonly session?: string) {}

  async complete<T>(req: LlmRequest): Promise<LlmResult<T>> {
    this.calls.push(req);
    const r = this.responders[req.kind];
    if (!r) throw new Error(`StubLlm: no responder for ${req.kind}`);
    const usage: Usage = { input: 1200, output: 400, cache_write: 0, cache_write_1h: 0, cache_read: 0 };
    const cost_usd = req.kind === 'judge' ? 0.05 : 0.004;
    recordTallySpend({ kind: req.kind, model: `stub:${req.model}`, cost_usd, usage, session: this.session });
    return { data: r(req) as T, usage, cost_usd, model: `stub:${req.model}`, duration_ms: 1 };
  }
}

export function runProcess(bin: string, args: string[], opts: { cwd?: string; timeoutMs: number; input?: string }): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child = spawn(bin, args, { cwd: opts.cwd, shell: isWin, windowsHide: true, env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'tally' } });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + String(e), code: -1, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

export function makeLlm(opts: { session?: string; stub?: Partial<Record<LlmRequest['kind'], StubResponder>> } = {}): LlmClient {
  if (opts.stub || process.env.TALLY_LLM === 'stub') return new StubLlm(opts.stub ?? defaultStubs(), opts.session);
  return new ClaudeCli({ session: opts.session });
}

export function defaultStubs(): Record<LlmRequest['kind'], StubResponder> {
  return {
    intake: () => ({
      title: 'Task',
      criteria: [{ text: 'The requested change is implemented', source: 'inferred' }],
      spec_quality: { score: 4, missing: ['acceptance criteria', 'test expectations'], questions: ['What does done look like?'] },
      estimate_hours: 2,
      rationale: 'stub',
    }),
    judge: () => ({
      criteria: [],
      quality_score: 6,
      quality_reason: 'stub',
      verdict_reason: 'stub',
      recommendations: ['stub'],
    }),
    coach: () => ({ suggestions: [] }),
  };
}
