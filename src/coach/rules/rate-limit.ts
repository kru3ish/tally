/* The 5-hour and 7-day usage limits, from the numbers Claude Code hands the status line (persisted per session by
   `tally statusline`). Warns at 80% with a burn-rate estimate of the minutes left, so a limit is not hit mid-task. */
import fs from 'node:fs';
import path from 'node:path';
import type { Rule, RuleContext, Suggestion } from '../types.js';
import { sessionDir, readJson } from '../../paths.js';

export interface RateLimits {
  ts: string;
  five_hour?: { used_percentage?: number; resets_at?: number } | null;
  seven_day?: { used_percentage?: number; resets_at?: number } | null;
}

export function rateLimitsFile(session: string): string {
  return path.join(sessionDir(session), 'rate-limits.json');
}

export function readRateLimits(session: string): RateLimits | null {
  const f = rateLimitsFile(session);
  return fs.existsSync(f) ? readJson<RateLimits | null>(f, null) : null;
}

export const RATE_WARN_PCT = 80;

export const rateLimit: Rule = {
  id: 'rate-limit',
  describe: 'The 5-hour or weekly usage limit is close at the current burn rate',
  evaluate(ctx: RuleContext): Suggestion[] {
    const rl = readRateLimits(ctx.session);
    if (!rl) return [];
    const out: Suggestion[] = [];
    for (const [name, w] of [['5-hour', rl.five_hour], ['weekly', rl.seven_day]] as const) {
      const pct = w?.used_percentage;
      if (typeof pct !== 'number' || pct < RATE_WARN_PCT) continue;
      const resetMin = w?.resets_at ? Math.max(0, Math.round((w.resets_at * 1000 - ctx.now.getTime()) / 60000)) : undefined;
      /* burn rate: percentage points per minute over the session so far, from the transcript's span */
      const spanMin = ctx.transcript?.startedAt ? Math.max(1, (ctx.now.getTime() - Date.parse(ctx.transcript.startedAt)) / 60000) : undefined;
      const perMin = spanMin ? pct / spanMin : undefined;
      const minutesLeft = perMin && perMin > 0 ? Math.round((100 - pct) / perMin) : undefined;
      out.push({
        rule: this.id,
        key: `rate:${name}:${Math.floor(pct / 10)}`,
        severity: pct >= 95 ? 'critical' : 'warn',
        title: `${name} usage limit at ${Math.round(pct)}%`,
        message: `${Math.round(pct)}% of the ${name} limit is used${resetMin !== undefined ? `; it resets in ${resetMin} min` : ''}${minutesLeft !== undefined ? `; at this session's pace it is reached in about ${minutesLeft} min` : ''}. Finish the piece in progress and leave the small fixes for after the reset.`,
        usd_saved: ctx.avgTurnCostUsd * 3,
        action: { kind: 'inject', label: 'Tell Claude to sequence the remaining work', note: `Tally observed the ${name} usage limit at ${Math.round(pct)}%${resetMin !== undefined ? `, resetting in ${resetMin} minutes` : ''}${minutesLeft !== undefined ? `, about ${minutesLeft} minutes away at the current pace` : ''}.` },
      });
    }
    return out;
  },
};
