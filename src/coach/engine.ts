import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import { mutesFile, readJson, sessionDir, writeJson, repoKey, ensureDir } from '../paths.js';
import { RULES } from './rules/index.js';
import type { Rule, RuleContext, Suggestion } from './types.js';

export interface EngineState {
  shown: number;
  last_shown_at?: string;
  shown_keys: string[];
  skips: Record<string, number>;
  llm_last_at?: string;
  llm_events_seen: number;
}

export interface Mutes {
  [repo: string]: Record<string, { at: string; reason: string }>;
}

export function stateFile(session: string): string {
  return path.join(sessionDir(session), 'coach-state.json');
}

export function loadState(session: string): EngineState {
  return readJson<EngineState>(stateFile(session), { shown: 0, shown_keys: [], skips: {}, llm_events_seen: 0 });
}

export function saveState(session: string, s: EngineState): void {
  ensureDir(sessionDir(session));
  writeJson(stateFile(session), s);
}

export function loadMutes(): Mutes {
  return readJson<Mutes>(mutesFile(), {});
}

export function muteRule(cwd: string, rule: string, reason: string): void {
  const m = loadMutes();
  const k = repoKey(cwd);
  m[k] ??= {};
  m[k][rule] = { at: new Date().toISOString(), reason };
  writeJson(mutesFile(), m);
}

export function unmuteRule(cwd: string, rule: string): void {
  const m = loadMutes();
  const k = repoKey(cwd);
  if (m[k]) delete m[k][rule];
  writeJson(mutesFile(), m);
}

export function isMuted(cwd: string, rule: string, mutes = loadMutes()): boolean {
  return !!mutes[repoKey(cwd)]?.[rule];
}

const SEV_RANK: Record<Suggestion['severity'], number> = { critical: 2, warn: 1, info: 0 };

export function rank(suggestions: Suggestion[]): Suggestion[] {
  return [...suggestions].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || b.usd_saved - a.usd_saved);
}

export interface TickResult {
  show: Suggestion[];
  held: Suggestion[];
  suppressed: Array<{ suggestion: Suggestion; why: string }>;
}

export class CoachEngine {
  constructor(
    public state: EngineState,
    private readonly cfg: Config,
    private readonly rules: Rule[] = RULES,
    private readonly mutes: Mutes = loadMutes(),
  ) {}

  evaluate(ctx: RuleContext): Suggestion[] {
    const all: Suggestion[] = [];
    for (const r of this.rules) {
      try {
        all.push(...r.evaluate(ctx));
      } catch (err) {
        all.push({ rule: r.id, key: `rule-error:${r.id}`, severity: 'info', title: `rule ${r.id} failed`, message: String(err), usd_saved: -1, action: { kind: 'none', label: '' } });
      }
    }
    return all.filter((s) => s.usd_saved >= 0);
  }

  /* Noise control: at most 1 non-critical suggestion per min_interval_s and max_per_session per session;
     critical ones (loops, 85% context, over budget) always pass. Duplicate keys and muted rules never show. */
  tick(ctx: RuleContext, candidates = this.evaluate(ctx)): TickResult {
    const result: TickResult = { show: [], held: [], suppressed: [] };
    const now = ctx.now.getTime();
    const sinceLast = this.state.last_shown_at ? (now - Date.parse(this.state.last_shown_at)) / 1000 : Infinity;
    let quotaLeft = this.state.shown < this.cfg.coach.max_per_session;
    let intervalOk = sinceLast >= this.cfg.coach.min_interval_s;
    for (const s of rank(candidates)) {
      if (isMuted(ctx.cwd, s.rule, this.mutes)) {
        result.suppressed.push({ suggestion: s, why: 'muted' });
        continue;
      }
      if (this.state.shown_keys.includes(s.key)) {
        result.suppressed.push({ suggestion: s, why: 'already shown' });
        continue;
      }
      const critical = s.severity === 'critical';
      if (!critical && (!quotaLeft || !intervalOk || result.show.some((x) => x.severity !== 'critical'))) {
        result.held.push(s);
        continue;
      }
      result.show.push({ ...s, ts: ctx.now.toISOString() });
      this.state.shown_keys.push(s.key);
      if (!critical) {
        this.state.shown += 1;
        this.state.last_shown_at = ctx.now.toISOString();
        quotaLeft = this.state.shown < this.cfg.coach.max_per_session;
        intervalOk = false;
      }
    }
    return result;
  }

  recordSkip(cwd: string, rule: string): { muted: boolean; skips: number } {
    const n = (this.state.skips[rule] ?? 0) + 1;
    this.state.skips[rule] = n;
    if (n >= this.cfg.coach.auto_mute_after_skips) {
      muteRule(cwd, rule, `skipped ${n} times`);
      this.mutes[repoKey(cwd)] ??= {};
      this.mutes[repoKey(cwd)]![rule] = { at: new Date().toISOString(), reason: `skipped ${n} times` };
      return { muted: true, skips: n };
    }
    return { muted: false, skips: n };
  }

  llmAllowed(now: Date, eventsCount: number, minNewEvents = 5): boolean {
    const since = this.state.llm_last_at ? (now.getTime() - Date.parse(this.state.llm_last_at)) / 1000 : Infinity;
    return since >= this.cfg.coach.llm_interval_s && eventsCount - this.state.llm_events_seen >= minNewEvents;
  }

  markLlm(now: Date, eventsCount: number): void {
    this.state.llm_last_at = now.toISOString();
    this.state.llm_events_seen = eventsCount;
  }
}

export function readClaudeMd(cwd: string): string | null {
  const p = path.join(cwd, 'CLAUDE.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}
