import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isolate, tmpDir } from './helpers.js';
import { scoreCounts, computeVerdict } from '../src/judge/judge.js';
import { sanitiseCheck } from '../src/task/intake.js';
import { tier2Estimate, backfillSpendSince, projectCost } from '../src/backfill/run.js';
import { loadConfig } from '../src/config.js';
import { recordTallySpend } from '../src/llm/client.js';
import { sessionDir, ensureDir } from '../src/paths.js';
import { BURN_MIN_USD, BURN_MIN_CALLS, BURN_WINDOW_MIN } from '../src/coach/rules/burn-rate.js';

let iso: ReturnType<typeof isolate>;
beforeEach(() => {
  iso = isolate();
});
afterEach(() => iso.restore());

describe('0.1.1 scoring: completion over verifiable criteria', () => {
  it('unverifiable criteria are a gap in the evidence, not a failure; value is still credited over all criteria', () => {
    const s = scoreCounts({ met: 2, partial: 0, unmet: 0, unverifiable: 2 }, 100, 10);
    expect(s.completion_pct).toBe(100);
    expect(s.verifiable).toBe(2);
    expect(s.total).toBe(4);
    expect(s.credited).toBe(50);
    expect(s.roi).toBe(5);
    expect(scoreCounts({ met: 0, partial: 0, unmet: 0, unverifiable: 3 }, 100, 10).completion_pct).toBe(0);
    expect(scoreCounts({ met: 1, partial: 1, unmet: 2, unverifiable: 0 }, 100, 10).completion_pct).toBe(37.5);
  });

  it('the verdict abstains (insufficient evidence) when nothing or most things could not be checked', () => {
    expect(computeVerdict({ completion_pct: 0, roi: null, quality: 7, testsFailed: false, verifiable: 0, unverifiable: 3 })).toBe('insufficient evidence');
    /* 100% of the 1 checkable criterion, 6 unverifiable: not "worth it" and not "not worth it" */
    expect(computeVerdict({ completion_pct: 100, roi: 3, quality: 7, testsFailed: false, verifiable: 1, unverifiable: 6 })).toBe('insufficient evidence');
    expect(computeVerdict({ completion_pct: 25, roi: 6, quality: 5, testsFailed: false, verifiable: 2, unverifiable: 4 })).toBe('insufficient evidence');
    /* a checkable majority keeps the old thresholds */
    expect(computeVerdict({ completion_pct: 100, roi: 3, quality: 7, testsFailed: false, verifiable: 3, unverifiable: 1 })).toBe('worth it');
    expect(computeVerdict({ completion_pct: 20, roi: 3, quality: 7, testsFailed: false, verifiable: 3, unverifiable: 1 })).toBe('not worth it');
    expect(computeVerdict({ completion_pct: 100, roi: 0.5, quality: 7, testsFailed: false })).toBe('not worth it');
  });
});

describe('0.1.1 intake and backfill guards', () => {
  it('drops checks whose path cannot be a repo file and keeps "." as "any file"', () => {
    expect(sanitiseCheck({ kind: 'file_exists', path: 'src/a.ts' })).toEqual({ kind: 'file_exists', path: 'src/a.ts' });
    expect(sanitiseCheck({ kind: 'file_changed', path: '.' })).toEqual({ kind: 'file_changed', path: '.' });
    expect(sanitiseCheck({ kind: 'file_exists', path: 'the readme file' })).toBeNull();
    expect(sanitiseCheck({ kind: 'file_exists', path: 'C:\\Users\\x\\a.ts' })).toBeNull();
    expect(sanitiseCheck({ kind: 'file_exists', path: '/etc/passwd' })).toBeNull();
    expect(sanitiseCheck({ kind: 'diff_contains', pattern: '429' })).toEqual({ kind: 'diff_contains', pattern: '429' });
    expect(sanitiseCheck(null)).toBeNull();
  });

  it('tier-2 projections scale with session size and the spend cap is cumulative across runs', () => {
    expect(tier2Estimate(5)).toBeCloseTo(0.17, 2);
    expect(tier2Estimate(128)).toBeCloseTo(0.66, 2);
    expect(tier2Estimate(769)).toBe(3);
    const cfg = loadConfig();
    const cand = (session: string, cost: number) => ({ session, transcript: '', cwd: 'C:/r', cost, prompts: ['x'], first_prompt: 'x', tool_calls: 1, files_edited: [], models: [], mtime: 0 });
    const proj = projectCost([cand('a', 1), cand('b', 769)], cfg);
    expect(proj.tier2_sessions).toBe(1);
    expect(proj.tier2_usd).toBe(3);
    /* spend recorded for a backfilled session counts; a live session's does not */
    ensureDir(sessionDir('bf-1'));
    fs.writeFileSync(path.join(sessionDir('bf-1'), 'backfill.json'), '{}');
    recordTallySpend({ kind: 'judge:tier2', model: 'm', cost_usd: 1.25, usage: { input: 1, output: 1, cache_write: 0, cache_write_1h: 0, cache_read: 0 }, session: 'bf-1' });
    recordTallySpend({ kind: 'judge:tier1', model: 'm', cost_usd: 0.5, usage: { input: 1, output: 1, cache_write: 0, cache_write_1h: 0, cache_read: 0 }, session: 'live-1' });
    expect(backfillSpendSince(24)).toBeCloseTo(1.25, 2);
    void tmpDir;
  });

  it('burn-rate needs more spend, more calls and repeats less often', () => {
    expect(BURN_MIN_USD).toBe(3);
    expect(BURN_MIN_CALLS).toBe(10);
    expect(BURN_WINDOW_MIN).toBe(15);
  });
});
