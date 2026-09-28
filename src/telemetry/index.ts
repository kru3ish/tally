/* Opt-in anonymous metrics. Off by default; the first interactive run asks once, default No.

   What can be sent, and nothing else (the schema is the allowlist below and is published in PRIVACY.md): Tally
   version, agent product, command name, success or failure, criterion counts by status, the verdict word, feedback
   labels, the usefulness answer, a random installation id, a timestamp. Never: prompts, code, diffs, file names, repo
   names, task text, terminal output, hostnames, usernames.

   Sending never blocks a command: events are appended to a local queue and a detached child process posts them with a
   short timeout; failures are silent and the queue is bounded. `TALLY_TELEMETRY=0`, a CI environment, `tally
   telemetry off` and a missing endpoint all mean nothing is sent. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendLine, ensureDir, packageRoot, readJson, tallyHome, writeJson } from '../paths.js';

export const TELEMETRY_SCHEMA = 'tally.telemetry.v1';
/* the default endpoint is empty on purpose: until a receiving endpoint exists nothing can be sent even when enabled */
export const DEFAULT_ENDPOINT = '';

export interface TelemetryState {
  enabled: boolean;
  /* when the consent question was asked (ISO); asked once, never again */
  asked?: string;
  installation_id?: string;
  endpoint?: string;
}

/* the whole allowlist; an event with any other key is rejected before it reaches the queue */
export const ALLOWED_FIELDS = ['schema', 'ts', 'installation_id', 'tally_version', 'agent', 'command', 'success', 'criteria', 'verdict', 'feedback_label', 'false_verified', 'usefulness_answer'] as const;
export type AllowedField = (typeof ALLOWED_FIELDS)[number];

export interface TelemetryEvent {
  schema: typeof TELEMETRY_SCHEMA;
  ts: string;
  installation_id: string;
  tally_version: string;
  agent?: 'claude-code' | 'codex' | 'gemini' | 'cursor' | 'unknown';
  command: string;
  success: boolean;
  criteria?: { verified: number; supported: number; unverified: number; unmet: number };
  verdict?: string;
  feedback_label?: 'correct' | 'wrong' | 'unsure';
  false_verified?: boolean;
  usefulness_answer?: 'yes' | 'no' | 'skip';
}

export function telemetryFile(): string {
  return path.join(tallyHome(), 'telemetry.json');
}

export function queueFile(): string {
  return path.join(tallyHome(), 'telemetry-queue.jsonl');
}

export function readTelemetry(): TelemetryState {
  return readJson<TelemetryState>(telemetryFile(), { enabled: false });
}

function save(s: TelemetryState): void {
  ensureDir(tallyHome());
  writeJson(telemetryFile(), s);
}

export function isCI(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.CI || env.GITHUB_ACTIONS || env.GITLAB_CI || env.BUILDKITE || env.CIRCLECI || env.TF_BUILD || env.JENKINS_URL);
}

/* the effective state: enabled in the file, not disabled by the environment, and an endpoint to send to */
export function telemetryActive(env: NodeJS.ProcessEnv = process.env): { active: boolean; reason: string; state: TelemetryState; endpoint: string } {
  const state = readTelemetry();
  const endpoint = env.TALLY_TELEMETRY_ENDPOINT || state.endpoint || DEFAULT_ENDPOINT;
  if (env.TALLY_TELEMETRY === '0' || env.TALLY_TELEMETRY === 'off' || env.TALLY_TELEMETRY === 'false') return { active: false, reason: 'TALLY_TELEMETRY=0 in the environment', state, endpoint };
  if (isCI(env)) return { active: false, reason: 'CI environment detected', state, endpoint };
  if (env.TALLY_INTERNAL === '1' || env.TALLY_LLM === 'stub') return { active: false, reason: "one of Tally's own runs", state, endpoint };
  if (!state.enabled) return { active: false, reason: state.asked ? 'declined (tally telemetry on to enable)' : 'not asked yet; default is off', state, endpoint };
  if (!endpoint) return { active: false, reason: 'enabled, but no endpoint is configured (TALLY_TELEMETRY_ENDPOINT); nothing is sent', state, endpoint };
  return { active: true, reason: `enabled, sending to ${endpoint}`, state, endpoint };
}

export function enableTelemetry(): TelemetryState {
  const s = readTelemetry();
  s.enabled = true;
  s.asked = s.asked ?? new Date().toISOString();
  if (!s.installation_id) s.installation_id = randomUUID();
  save(s);
  return s;
}

/* off deletes the installation id: a later opt-in gets a fresh one, so the two cannot be joined */
export function disableTelemetry(): TelemetryState {
  const s = readTelemetry();
  s.enabled = false;
  s.asked = s.asked ?? new Date().toISOString();
  delete s.installation_id;
  save(s);
  try {
    fs.rmSync(queueFile(), { force: true });
  } catch {
    /* nothing queued */
  }
  return s;
}

export function markAsked(): void {
  const s = readTelemetry();
  s.asked = s.asked ?? new Date().toISOString();
  save(s);
}

export const CONSENT_QUESTION = 'Enable anonymous metrics? Version, command name, success, criterion and verdict counts, feedback labels, a random installation id. Never prompts, code, diffs, names or paths (PRIVACY.md). [y/N] ';

/* whether the first-run consent question is due: interactive, not CI, not disabled by env, not asked before */
export function shouldAskConsent(opts: { interactive: boolean; env?: NodeJS.ProcessEnv }): boolean {
  const env = opts.env ?? process.env;
  if (!opts.interactive || isCI(env)) return false;
  if (env.TALLY_TELEMETRY !== undefined || env.TALLY_INTERNAL === '1' || env.TALLY_LLM === 'stub') return false;
  return !readTelemetry().asked;
}

function version(): string {
  return readJson<{ version?: string }>(path.join(packageRoot(), 'package.json'), {}).version ?? '0.0.0';
}

/* build a full event from partial fields; unknown keys are dropped, so a caller cannot widen the schema by accident */
export function makeEvent(fields: Partial<TelemetryEvent> & { command: string; success: boolean }, state: TelemetryState): TelemetryEvent {
  const raw: Record<string, unknown> = { ...fields, schema: TELEMETRY_SCHEMA, ts: new Date().toISOString(), installation_id: state.installation_id ?? 'none', tally_version: version() };
  const ev: Record<string, unknown> = {};
  for (const k of ALLOWED_FIELDS) if (raw[k] !== undefined) ev[k] = raw[k];
  return ev as unknown as TelemetryEvent;
}

const QUEUE_CAP = 500;

/* record an event: no-op unless telemetry is active; append to the queue and start a detached flush */
export function record(fields: Partial<TelemetryEvent> & { command: string; success: boolean }, opts: { spawnFlush?: boolean } = {}): TelemetryEvent | null {
  const t = telemetryActive();
  if (!t.active) return null;
  const ev = makeEvent(fields, t.state);
  ensureDir(tallyHome());
  try {
    const q = queueFile();
    if (fs.existsSync(q) && fs.readFileSync(q, 'utf8').split('\n').filter(Boolean).length >= QUEUE_CAP) return ev;
    appendLine(q, JSON.stringify(ev));
  } catch {
    return ev;
  }
  if (opts.spawnFlush !== false && !process.env.TALLY_NO_SPAWN) {
    try {
      const child = spawn(process.execPath, [path.join(packageRoot(), 'dist', 'cli.js'), 'telemetry', 'flush', '--auto'], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
      child.unref();
    } catch {
      /* the next command's flush will pick it up */
    }
  }
  return ev;
}

/* post the queue to the endpoint; on 2xx the sent lines are removed; on anything else they stay (bounded) and nothing is said */
export async function flush(opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<{ sent: number; status?: number; skipped?: string }> {
  const t = telemetryActive();
  if (!t.active) return { sent: 0, skipped: t.reason };
  const q = queueFile();
  if (!fs.existsSync(q)) return { sent: 0 };
  const lines = fs.readFileSync(q, 'utf8').split('\n').filter(Boolean);
  if (!lines.length) return { sent: 0 };
  const f = opts.fetchImpl ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 4000);
  try {
    const res = await f(t.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: `[${lines.join(',')}]`, signal: ctl.signal });
    if (res.ok) {
      fs.rmSync(q, { force: true });
      return { sent: lines.length, status: res.status };
    }
    return { sent: 0, status: res.status };
  } catch {
    return { sent: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/* an example event for `tally telemetry show`: the exact shape, with representative values */
export function exampleEvent(state: TelemetryState): TelemetryEvent {
  return makeEvent({ command: 'verify', success: true, agent: 'claude-code', criteria: { verified: 2, supported: 1, unverified: 1, unmet: 0 }, verdict: 'borderline' }, { ...state, installation_id: state.installation_id ?? '<random uuid, created on opt-in>' });
}
