import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import { testRerunConsent } from '../config.js';
import type { LlmClient } from '../llm/client.js';
import { parseTranscriptFile } from '../transcript/parse.js';
import { sessionDir, ensureDir, writeJson, appendLine } from '../paths.js';
import { eventsFile } from '../store/events.js';
import { intake, loadTask, type Task } from '../task/intake.js';
import { fetchTask, type FetchDeps } from '../task/fetchers.js';
import { judgeSession, tallyOwnSpend, loadJudge } from '../judge/judge.js';
import { followupSession, type FollowupDeps } from '../followup/followup.js';
import type { Judge } from '../judge/schema.js';
import { detectTaskLink, realLinkDeps, type LinkDeps, type TaskLink } from './link.js';
import { reconstructWindow, addWorktree, runHistoricalTests, gitExecRaw, HISTORICAL_UNRUNNABLE, type Exec } from './history.js';
import { eventsFromTranscript, replayCoach, type CoachReplay } from './events.js';
import { ticketAsOf } from './ticket.js';
import type { SessionCandidate } from './scan.js';
import { loadHistory } from '../coach/context.js';

export interface BackfillDeps {
  link?: LinkDeps;
  git?: Exec;
  fetch?: FetchDeps;
  followup?: FollowupDeps;
  ghOk?: boolean;
}

export interface BackfillResult {
  session: string;
  link: TaskLink;
  window: { start_head?: string; end_head?: string; commits_in_window: number; notes: string[] };
  task?: Task;
  judge?: Judge;
  replay?: CoachReplay;
  skipped?: string;
  tally_spend_usd: number;
}

export interface CostProjection {
  sessions: number;
  intake_usd: number;
  tier1_usd: number;
  tier2_usd: number;
  total_usd: number;
  tier2_sessions: number;
}

/* Rough per-session prices from the calibration receipts: intake ≈ $0.01 (0 on cache hit), tier 1 ≈ $0.015, tier 2 ≈ $0.12 above the deep threshold. */
export function projectCost(candidates: SessionCandidate[], cfg: Config): CostProjection {
  const tier2 = candidates.filter((c) => c.cost >= cfg.judge.deepThreshold).length;
  const n = candidates.length;
  const intake = n * 0.01;
  const tier1 = n * 0.015;
  const t2 = tier2 * 0.12;
  return { sessions: n, intake_usd: intake, tier1_usd: tier1, tier2_usd: t2, total_usd: intake + tier1 + t2, tier2_sessions: tier2 };
}

export function backfillSessionDir(session: string): string {
  return sessionDir(session);
}

export async function backfillSession(c: SessionCandidate, opts: { cfg: Config; llm: LlmClient; taskRef?: string; deps?: BackfillDeps; log?: (s: string) => void }): Promise<BackfillResult> {
  const log = opts.log ?? (() => {});
  const cfg = opts.cfg;
  const deps = opts.deps ?? {};
  const session = c.session;
  const cwd = c.cwd;
  const t = parseTranscriptFile(c.transcript);
  if (t.internal) return { session, link: { kind: 'none', ref: '', confidence: 0, evidence: 'internal run' }, window: { commits_in_window: 0, notes: [] }, skipped: 'internal Tally run', tally_spend_usd: 0 };
  if (!cwd || !fs.existsSync(cwd)) return { session, link: { kind: 'none', ref: '', confidence: 0, evidence: 'cwd missing' }, window: { commits_in_window: 0, notes: [] }, skipped: `repo directory no longer exists: ${cwd ?? '?'}`, tally_spend_usd: 0 };
  const start = c.started ?? t.startedAt ?? new Date().toISOString();
  const end = c.ended ?? t.endedAt ?? start;

  const link = opts.taskRef ? { kind: /^https?:\/\//.test(opts.taskRef) ? ('url' as const) : ('key' as const), ref: opts.taskRef, url: /^https?:\/\//.test(opts.taskRef) ? opts.taskRef : undefined, confidence: 1, evidence: 'given with --task' } : detectTaskLink({ cwd, branch: c.branch, prompts: c.prompts, start, end }, deps.link ?? realLinkDeps);
  const window = reconstructWindow(cwd, { branch: c.branch, start, end, exec: deps.git, ghOk: deps.ghOk });
  log(`  window: ${window.start_head?.slice(0, 8) ?? '?'} → ${window.end_head?.slice(0, 8) ?? '?'} (${window.commits_in_window} commit(s))${window.notes.length ? '; ' + window.notes.join('; ') : ''}`);
  if (!window.end_head || !window.start_head) return { session, link, window, skipped: 'could not reconstruct the session window from git history', tally_spend_usd: 0 };

  const dir = ensureDir(sessionDir(session)) ?? sessionDir(session);
  const events = eventsFromTranscript(t, session, cwd, c.transcript, window.start_head);
  fs.writeFileSync(eventsFile(session), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeJson(path.join(dir, 'backfill.json'), { session, link, window, started: start, ended: end, repo: cwd, transcript: c.transcript, backfilled_at: new Date().toISOString() });

  /* intake against the ticket as it read at session start when the tracker keeps history */
  let task = loadTask(session);
  if (!task) {
    const ref = link.url ?? (link.kind === 'key' ? link.ref : undefined);
    const text = c.prompts[0] ?? c.first_prompt;
    const fetched = await fetchTask(ref ?? text, { cwd, cfg, deps: deps.fetch, promptText: text });
    const asOf = ref ? await ticketAsOf(fetched, start, cfg, deps.fetch) : { title: fetched.title, body: fetched.body, as_of: 'current' as const, note: 'no tracker link; criteria come from the first prompt as recorded in the transcript' };
    const r = await intake({ session, cwd, ref, text: ref ? undefined : text, cfg, llm: opts.llm, deps: deps.fetch, override: { title: asOf.title, body: asOf.body }, historical: { ticket_as_of: asOf.as_of, note: asOf.note } });
    task = r.task;
    log(`  task: "${task.title}" (${task.criteria.length} criteria, ${task.criteria.filter((x) => x.kind === 'mechanical').length} mechanical${task.cached ? ', intake cached' : ''}) · ${asOf.note}`);
  }

  const wt = addWorktree(cwd, window.end_head, deps.git ?? gitExecRaw);
  let judge: Judge | undefined;
  try {
    const consent = testRerunConsent(cfg, cwd);
    const ver = await runHistoricalTests(wt.path, { consent, timeoutMs: cfg.judge.test_timeout_ms });
    log(`  tests: ${ver.ran ? `${ver.command} → ${ver.passed ? 'passed' : 'failed'}` : ver.reason}`);
    judge = await judgeSession({ session, cwd: wt.path, repoCwd: cwd, transcriptPath: c.transcript, cfg, llm: opts.llm, reason: 'manual', events, verification: ver, task, consent, historical: { start_head: window.start_head, end_head: window.end_head, notes: [...window.notes, ver.reason?.startsWith(HISTORICAL_UNRUNNABLE) ? ver.reason : ''].filter(Boolean) } });
  } finally {
    wt.remove();
  }
  const fu = followupSession(session, deps.followup);
  if (fu) judge = fu;
  log(`  judged: ${judge.verdict.verdict} (${judge.completion_pct}%), tiers ${judge.tiers.ran.join('→')}${judge.followup ? ` · follow-up: ${judge.followup.final_status} → ${judge.followup.final_verdict}` : ''}`);

  const replay = replayCoach({ session, cwd, cfg, events, transcript: t, history: loadHistory() });
  writeJson(path.join(dir, 'coach_replay.json'), replay);
  log(`  coach replay: ${replay.shown.length} suggestion(s) would have shown (${replay.held} held by noise limits)`);
  appendLine(path.join(sessionDir(session), 'backfill.log'), `${new Date().toISOString()} backfilled`);
  return { session, link, window, task, judge, replay, tally_spend_usd: tallyOwnSpend(session) };
}

export function isBackfilled(session: string): boolean {
  return fs.existsSync(path.join(sessionDir(session), 'backfill.json')) && !!loadJudge(session);
}
