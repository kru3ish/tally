import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolate, basicFixture, root } from './helpers.js';
import { parseTranscriptFile, readTranscriptLines, parseTranscript, isKnownFormatVersion } from '../src/transcript/parse.js';
import { loadHistory } from '../src/coach/context.js';
import { computeTrend } from '../src/report/report.js';
import { findDeadWeight } from '../src/coach/rules/dead-weight.js';
import { buildContext } from '../src/coach/context.js';
import { loadConfig } from '../src/config.js';
import { isInternalCwd } from '../src/paths.js';
import { ClaudeCli } from '../src/llm/client.js';
import type { HistoryEntry } from '../src/coach/types.js';

let iso: ReturnType<typeof isolate>;
beforeEach(() => {
  iso = isolate();
});
afterEach(() => iso.restore());

const HOOK = path.join(root, 'dist', 'hook.js');

describe('H1 self-isolation', () => {
  it('hooks exit at once and record nothing when TALLY_INTERNAL=1', () => {
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd']) {
      const r = spawnSync(process.execPath, [HOOK, ev], { input: JSON.stringify({ session_id: 'internal-1', cwd: 'C:/x', prompt: 'hi', tool_name: 'Bash', tool_input: { command: 'git push' }, tool_response: 'ok' }), encoding: 'utf8', env: { ...process.env, TALLY_INTERNAL: '1', TALLY_NO_SPAWN: '1' } });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    }
    expect(fs.existsSync(path.join(iso.home, 'sessions'))).toBe(false);
    expect(fs.existsSync(path.join(iso.home, 'active.json'))).toBe(false);
    expect(fs.existsSync(path.join(iso.home, 'spawn.log'))).toBe(false);
  });

  it('the internal claude -p launcher sets TALLY_INTERNAL, the isolation flags, and an internal cwd', async () => {
    const fake = path.join(iso.home, 'fake-claude.js');
    fs.writeFileSync(
      fake,
      `process.stdout.write(JSON.stringify({ structured_output: { env: process.env.TALLY_INTERNAL, entry: process.env.CLAUDE_CODE_ENTRYPOINT, args: process.argv.slice(2), cwd: process.cwd() }, total_cost_usd: 0.001, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: { 'claude-haiku-4-5': {} } }));`,
    );
    const cli = new ClaudeCli({ claudeBin: fake, session: 'sess-x' });
    const r = await cli.complete<{ env: string; entry: string; args: string[]; cwd: string }>({ kind: 'coach', model: 'haiku', system: 'sys', prompt: 'hello', schema: { type: 'object' } });
    expect(r.data.env).toBe('1');
    expect(r.data.entry).toBe('tally');
    expect(isInternalCwd(r.data.cwd)).toBe(true);
    const a = r.data.args;
    for (const flag of ['--setting-sources', '--strict-mcp-config', '--no-session-persistence', '--tools', '--max-turns', '--json-schema', '--system-prompt']) expect(a).toContain(flag);
    expect(a[a.indexOf('--setting-sources') + 1]).toBe('');
    expect(a[a.indexOf('--tools') + 1]).toBe('');
    expect(r.cost_usd).toBe(0.001);
    expect(fs.readFileSync(path.join(iso.home, 'tally-spend.jsonl'), 'utf8')).toContain('"sess-x"');
    expect(fs.existsSync(path.join(iso.home, 'sessions'))).toBe(false);
  });

  it('tags transcripts from internal cwds or the tally entrypoint and excludes them from stats', () => {
    expect(isInternalCwd('C:\\Users\\x\\AppData\\Local\\Temp\\tally-llm-abc123')).toBe(true);
    expect(isInternalCwd('/tmp/tally-llm-abc')).toBe(true);
    expect(isInternalCwd('C:/Users/x/dev/app')).toBe(false);
    const t = parseTranscriptFile(path.join(basicFixture, 'transcript.jsonl'));
    expect(t.internal).toBe(false);
    const { lines } = readTranscriptLines(path.join(basicFixture, 'transcript.jsonl'));
    const tagged = parseTranscript(lines.map((l) => ({ ...l, cwd: '/tmp/tally-llm-xyz' })));
    expect(tagged.internal).toBe(true);
    const byEntry = parseTranscript(lines.map((l) => ({ ...l, entrypoint: 'tally' })));
    expect(byEntry.internal).toBe(true);

    const repo = 'c:/repo';
    const h: HistoryEntry[] = [
      { ts: '2026-09-01T00:00:00Z', kind: 'session', session: 'a', repo, loaded: { mcp: ['x'], skills: [], plugins: [] }, used: { mcp: [], skills: [] }, first_turn_tokens: 40000 },
      { ts: '2026-09-02T00:00:00Z', kind: 'session', session: 'b', repo, loaded: { mcp: ['x'], skills: [], plugins: [] }, used: { mcp: [], skills: [] }, first_turn_tokens: 40000 },
      { ts: '2026-09-03T00:00:00Z', kind: 'session', session: 'c', repo, loaded: { mcp: ['x'], skills: [], plugins: [] }, used: { mcp: [], skills: [] }, first_turn_tokens: 40000 },
      { ts: '2026-09-04T00:00:00Z', kind: 'session', session: 'i1', repo, internal: true, loaded: { mcp: ['x'], skills: [], plugins: [] }, used: { mcp: [], skills: [] }, first_turn_tokens: 7000 },
      { ts: '2026-09-04T00:00:00Z', session: 'i2', repo, internal: true, verdict: 'worth it', completion_pct: 100, cost_usd: 0.01 },
      { ts: '2026-09-05T00:00:00Z', session: 'i3', repo: '/tmp/tally-llm-q', verdict: 'worth it', completion_pct: 100, cost_usd: 0.01 },
      { ts: '2026-09-05T00:00:00Z', session: 'r1', repo, verdict: 'borderline', completion_pct: 50, cost_usd: 2, linked: true },
    ];
    fs.writeFileSync(path.join(iso.home, 'history.jsonl'), h.map((x) => JSON.stringify(x)).join('\n') + '\n');
    const loaded = loadHistory();
    expect(loaded.map((x) => x.session)).toEqual(['a', 'b', 'c', 'r1']);
    const trend = computeTrend({ repo, history: h });
    expect(trend.tasks).toBe(1);
    expect(trend.sessions).toBe(3);
    const ctx = buildContext({ session: 's', cwd: 'C:\\repo', cfg: loadConfig(), events: [], history: h });
    const dw = findDeadWeight(ctx);
    expect(dw.sessions).toBe(3);
    expect(dw.avg_first_turn).toBe(40000);
  });

  it('counts unparseable lines, detects the format version, and marks cost partial on unknown layouts', () => {
    const good = parseTranscriptFile(path.join(basicFixture, 'transcript.jsonl'));
    expect(good.format.known).toBe(true);
    expect(good.format.version).toBe('2.1.268');
    expect(good.format.unparseable_lines).toBe(0);
    expect(good.cost_confidence).toBe('full');
    const torn = path.join(iso.home, 'torn.jsonl');
    fs.writeFileSync(torn, fs.readFileSync(path.join(basicFixture, 'transcript.jsonl'), 'utf8') + '{"type":"assistant","mess\n[1,2]\n{"type":"weird-new-kind","x":1}\n');
    const t = parseTranscriptFile(torn);
    expect(t.format.unparseable_lines).toBe(2);
    expect(t.format.unknown_types).toEqual(['weird-new-kind']);
    expect(t.cost_confidence).toBe('partial');
    expect(t.cost).toBeCloseTo(good.cost, 6);
    expect(isKnownFormatVersion('2.1.300')).toBe(true);
    expect(isKnownFormatVersion('3.0.1')).toBe(false);
    const { lines } = readTranscriptLines(path.join(basicFixture, 'transcript.jsonl'));
    const future = parseTranscript(lines.map((l) => ({ ...l, version: '3.0.0' })));
    expect(future.format.known).toBe(false);
    expect(future.cost_confidence).toBe('partial');
  });
});
