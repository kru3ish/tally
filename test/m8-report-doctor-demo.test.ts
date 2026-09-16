import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolate, root, tmpDir } from './helpers.js';
import { computeTrend, renderTrend } from '../src/report/report.js';
import { runChecks } from '../src/commands/doctor.js';
import { runDemo } from '../src/demo/demo.js';
import type { HistoryEntry } from '../src/coach/types.js';

let iso: ReturnType<typeof isolate>;
beforeEach(() => {
  iso = isolate();
});
afterEach(() => iso.restore());

describe('report', () => {
  it('computes trends, rework, and skill/MCP payoff from history', () => {
    const repo = 'c:/repo';
    const h: HistoryEntry[] = [
      { ts: '2026-09-01T00:00:00Z', kind: 'session', session: 'a', repo },
      { ts: '2026-09-01T01:00:00Z', session: 'a', repo, verdict: 'worth it', completion_pct: 100, cost_usd: 2, per_criterion_usd: 1, waste_usd: 0.2, skills: ['tdd'], mcp: ['github:issue_read'], linked: true, final_status: 'held up', final_verdict: 'worth it', recommendations: ['Run tests once.'] },
      { ts: '2026-09-02T00:00:00Z', kind: 'session', session: 'b', repo },
      { ts: '2026-09-02T01:00:00Z', session: 'b', repo, verdict: 'borderline', completion_pct: 50, cost_usd: 4, per_criterion_usd: 4, waste_usd: 1, skills: [], mcp: [], linked: false, final_status: 'reverted', final_verdict: 'not worth it', recommendations: ['Run tests once.'] },
      { ts: '2026-09-03T01:00:00Z', session: 'c', repo: 'other', verdict: 'worth it', completion_pct: 80, cost_usd: 1, per_criterion_usd: 0.5, linked: true },
    ];
    const t = computeTrend({ repo, history: h });
    expect(t.tasks).toBe(2);
    expect(t.sessions).toBe(2);
    expect(t.cost_per_task_usd).toBe(3);
    expect(t.completion_pct).toBe(75);
    expect(t.rework_rate).toBe(0.5);
    expect(t.linked_rate).toBe(0.5);
    expect(t.verdicts).toEqual({ 'worth it': 1, 'not worth it': 1 });
    const tdd = t.payoff.find((p) => p.name === 'tdd')!;
    expect(tdd.completion_with).toBe(100);
    expect(tdd.completion_without).toBe(50);
    expect(t.top_recommendations[0]).toEqual({ text: 'Run tests once.', count: 2 });
    const text = renderTrend(t, { repo });
    expect(text).toContain('rework rate          50%');
    expect(text).toContain('correlational');
    expect(computeTrend({ history: h }).tasks).toBe(3);
    expect(renderTrend(computeTrend({ history: [] }))).toContain('No receipts yet');
  });
});

describe('doctor', () => {
  it('runs every check and reports hook runtime under 150ms', () => {
    const checks = runChecks();
    const names = checks.map((c) => c.name);
    for (const n of ['node', 'claude', 'gh', 'hooks', 'hook runtime', 'data dir', 'config', 'pricing', 'jira', 'linear', 'tmux', 'transcripts', 'sessions']) expect(names).toContain(n);
    expect(checks.find((c) => c.name === 'node')!.ok).toBe(true);
    expect(checks.find((c) => c.name === 'hook runtime')!.detail).toMatch(/exit 0/);
    expect(checks.find((c) => c.name === 'hooks')!.ok).toBe(false);
    const r = spawnSync(process.execPath, [path.join(root, 'dist', 'cli.js'), 'doctor', '--plain'], { encoding: 'utf8', env: { ...process.env } });
    expect(r.stdout).toContain('hook runtime');
  });
});

describe('demo (definition of done)', () => {
  it('replays the fixture end to end with a stubbed LLM without touching the real ~/.claude', async () => {
    const home = tmpDir('tally-demo-test-');
    const realClaude = process.env.CLAUDE_CONFIG_DIR;
    let text = '';
    const r = await runDemo({ out: (s) => (text += s + '\n'), color: false, home, fast: true });
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(realClaude);
    expect(text).toContain('Spec quality: 4/10  -> Clarify the ticket first');
    expect(text).toContain('Does a successful login reset the counter?');
    expect(r.suggestionsShown).toBeGreaterThanOrEqual(5);
    expect(text).toContain('Same command failed 3');
    expect(r.applied.length).toBe(1);
    expect(r.injected.length).toBe(1);
    expect(text).toContain('[a] applied');
    expect(text).toContain('[i] injected');
    expect(text).toContain('hook delivered to Claude: [Tally]');
    expect(r.shipDetected).toBe(true);
    expect(text).toContain('ship detected (git push)');
    expect(text).toContain('Tally receipt');
    expect(text).toContain('Cost (API-equivalent)');
    expect(text).toContain('waste');
    expect(text).toContain('ROI');
    expect(text).toMatch(/npm test → passed/);
    expect(['worth it', 'borderline', 'not worth it']).toContain(r.verdict);
    expect(r.finalVerdict).toBe('not worth it');
    expect(text).toContain('(reverted)');
    expect(fs.existsSync(r.reportPath)).toBe(true);
    const report = fs.readFileSync(r.reportPath, 'utf8');
    expect(report).toContain('after follow-up: **NOT WORTH IT**');
    expect(report).toContain('## Waste');
    expect(fs.existsSync(path.join(home, 'tally', 'sessions'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'acme-app', 'CLAUDE.md'))).toBe(true);
    const state = JSON.parse(fs.readFileSync(path.join(home, 'tally', 'sessions', r.session, 'coach-state.json'), 'utf8')) as { shown: number };
    expect(state.shown).toBeLessThanOrEqual(8);
    fs.rmSync(home, { recursive: true, force: true });
  }, 120000);

  it('runs from the CLI', () => {
    const r = spawnSync(process.execPath, [path.join(root, 'dist', 'cli.js'), 'demo', '--plain', '--fast'], { encoding: 'utf8', env: { ...process.env }, timeout: 120000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Done.');
  }, 130000);
});
