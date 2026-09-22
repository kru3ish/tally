import fs from 'node:fs';
import path from 'node:path';
import type { Judge, Verdict } from '../judge/schema.js';
import { JudgeSchema } from '../judge/schema.js';
import { loadJudge, judgeFile, persistJudge } from '../judge/judge.js';
import { loadTask } from '../task/intake.js';
import { listSessions } from '../store/events.js';
import { tallyHome, readJson, writeJson, log } from '../paths.js';
import type { Exec } from '../judge/evidence.js';
import { gitExec } from '../judge/evidence.js';
import { ghStatus } from './gh.js';

export type FinalStatus = NonNullable<Judge['followup']>['final_status'];

export interface FollowupDeps {
  exec: Exec;
  now?: () => Date;
}

export const realFollowupDeps: FollowupDeps = { exec: gitExec };

interface PrView {
  state?: string;
  mergedAt?: string | null;
  createdAt?: string | null;
  mergeCommit?: { oid?: string } | null;
  reviews?: Array<{ state?: string }>;
  comments?: Array<unknown>;
  number?: number;
  headRefName?: string;
  closed?: boolean;
}

function parseJson<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

export function adjustVerdict(original: Verdict, status: FinalStatus): Verdict {
  if (status === 'reverted') return 'not worth it';
  if (original === 'insufficient evidence') return status === 'held up' ? 'borderline' : original;
  if (status === 'needed rework') return original === 'worth it' ? 'borderline' : 'not worth it';
  return original;
}

export function detectRevert(cwd: string, exec: Exec, hints: { prNumber?: number; mergeSha?: string; branch?: string; since?: string }): { reverted: boolean; commit?: string } {
  const args = ['log', '--format=%H%x09%s%x09%b', '-n', '400', '-i', '--grep=revert'];
  if (hints.since) args.push(`--since=${hints.since}`);
  const r = exec('git', args, cwd);
  if (!r.ok) return { reverted: false };
  for (const line of r.stdout.split('\n')) {
    const [sha, subject = '', body = ''] = line.split('\t');
    const text = `${subject} ${body}`;
    if (!/revert/i.test(subject)) continue;
    if (hints.prNumber && new RegExp(`#${hints.prNumber}\\b`).test(text)) return { reverted: true, commit: sha };
    if (hints.mergeSha && text.includes(hints.mergeSha.slice(0, 7))) return { reverted: true, commit: sha };
    if (hints.branch && text.includes(hints.branch)) return { reverted: true, commit: sha };
  }
  return { reverted: false };
}

export function followupSession(session: string, deps: FollowupDeps = realFollowupDeps): Judge | null {
  const judge = loadJudge(session);
  if (!judge) return null;
  const cwd = judge.cwd ?? process.cwd();
  const now = deps.now?.() ?? new Date();
  const notes: string[] = [];
  const fu: NonNullable<Judge['followup']> = { checked_at: now.toISOString(), final_status: 'unknown', final_verdict: judge.verdict.verdict, original_verdict: judge.verdict.verdict, notes };

  const prUrl = judge.evidence.ship_events.map((s) => s.url).find((u) => u && /\/pull\/\d+/.test(u)) ?? (judge.task.source.url && /\/pull\/\d+/.test(judge.task.source.url) ? judge.task.source.url : undefined);
  const issueUrl = judge.task.source.url && /\/issues\/\d+/.test(judge.task.source.url) ? judge.task.source.url : undefined;
  let prNumber: number | undefined;
  let mergeSha: string | undefined;
  let branch = judge.evidence.branch;

  const needsGh = !!(prUrl || issueUrl);
  const gh = needsGh && deps === realFollowupDeps ? ghStatus() : { ok: true, reason: '', fix: '' };
  if (needsGh && !gh.ok) {
    notes.push(`Follow-up skipped: ${gh.reason}. Fix: ${gh.fix}. Revert detection still ran on the local git log.`);
    fu.gh_skipped = true;
  }

  if (prUrl && gh.ok) {
    const r = deps.exec('gh', ['pr', 'view', prUrl, '--json', 'state,mergedAt,createdAt,mergeCommit,reviews,comments,number,headRefName,closed'], cwd);
    const pr = r.ok ? parseJson<PrView>(r.stdout) : null;
    if (pr) {
      prNumber = pr.number;
      branch = pr.headRefName ?? branch;
      fu.pr_state = pr.state;
      fu.merged = pr.state === 'MERGED' || !!pr.mergedAt;
      mergeSha = pr.mergeCommit?.oid ?? undefined;
      const reviews = pr.reviews ?? [];
      fu.review_comments = (pr.comments?.length ?? 0) + reviews.length;
      fu.change_requests = reviews.filter((x) => x.state === 'CHANGES_REQUESTED').length;
      /* review burden: every review submission is a round; approval time runs from PR open to merge */
      fu.review_rounds = reviews.length;
      if (pr.createdAt && pr.mergedAt) fu.hours_to_approval = Math.round(((Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / 3600e3) * 10) / 10;
      if (fu.hours_to_approval !== undefined) notes.push(`Review burden: ${fu.review_rounds} review round(s), ${fu.hours_to_approval} h from open to merge.`);
      notes.push(`PR ${prUrl} is ${pr.state}${fu.merged ? ' (merged)' : ''}; ${fu.review_comments} review comments, ${fu.change_requests} change requests.`);
      if (fu.merged && mergeSha) {
        const runs = deps.exec('gh', ['run', 'list', '--commit', mergeSha, '--json', 'conclusion,status,name', '--limit', '20'], cwd);
        const list = runs.ok ? parseJson<Array<{ conclusion?: string; status?: string; name?: string }>>(runs.stdout) ?? [] : [];
        const failed = list.filter((x) => x.conclusion === 'failure');
        fu.ci_failed_after_merge = failed.length > 0;
        if (list.length) notes.push(`CI on merge commit: ${failed.length ? `${failed.length} failed (${failed.map((f) => f.name).join(', ')})` : 'green'}.`);
      }
    } else {
      notes.push(`Could not read PR ${prUrl} (${r.stderr.trim().slice(0, 120) || 'gh unavailable'}).`);
    }
  } else if (!prUrl) {
    notes.push('No PR URL recorded for this session.');
  }

  if (issueUrl && gh.ok) {
    const m = /github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/.exec(issueUrl);
    if (m) {
      const r = deps.exec('gh', ['api', `repos/${m[1]}/${m[2]}/issues/${m[3]}/events`, '--jq', '[.[] | {event, created_at}]'], cwd);
      const evs = r.ok ? parseJson<Array<{ event: string; created_at: string }>>(r.stdout) ?? [] : [];
      fu.issue_reopened = evs.some((e) => e.event === 'reopened' && e.created_at > judge.judged_at);
      const state = deps.exec('gh', ['issue', 'view', issueUrl, '--json', 'state'], cwd);
      const st = state.ok ? parseJson<{ state?: string }>(state.stdout)?.state : undefined;
      notes.push(`Issue ${issueUrl} is ${st ?? 'unknown'}${fu.issue_reopened ? ' and was reopened after the receipt' : ''}.`);
    }
  }

  /* full ISO timestamp, one day of slack: a date-only --since is parsed in git's local midnight and can drop same-day commits */
  const sinceIso = new Date(Date.parse(judge.judged_at) - 24 * 3600 * 1000).toISOString();
  const revert = detectRevert(cwd, deps.exec, { prNumber, mergeSha, branch, since: sinceIso });
  fu.reverted = revert.reverted;
  if (revert.reverted) {
    fu.revert_commit = revert.commit;
    notes.push(`Reverted in ${revert.commit?.slice(0, 8) ?? 'a later commit'}.`);
  }

  if (fu.reverted) fu.final_status = 'reverted';
  else if ((fu.change_requests ?? 0) > 0 || fu.issue_reopened || fu.ci_failed_after_merge || (fu.pr_state === 'CLOSED' && !fu.merged)) fu.final_status = 'needed rework';
  else if (fu.merged) fu.final_status = 'held up';
  else fu.final_status = 'unknown';
  fu.final_verdict = adjustVerdict(judge.verdict.verdict, fu.final_status);
  if (fu.final_verdict !== fu.original_verdict) notes.push(`Verdict adjusted from "${fu.original_verdict}" to "${fu.final_verdict}".`);

  const updated: Judge = JudgeSchema.parse({ ...judge, followup: fu });
  persistJudge(updated, loadTask(session));
  return updated;
}

export function followupStateFile(): string {
  return path.join(tallyHome(), 'followup-state.json');
}

export function dueSessions(days: number, now = new Date()): string[] {
  const out: string[] = [];
  for (const id of listSessions()) {
    const j = loadJudge(id);
    if (!j) continue;
    const age = (now.getTime() - Date.parse(j.judged_at)) / 86400000;
    if (age < days || age > 90) continue;
    if (j.followup && j.followup.final_status !== 'unknown') continue;
    if (j.followup && (now.getTime() - Date.parse(j.followup.checked_at)) / 86400000 < days) continue;
    out.push(id);
  }
  return out;
}

export function runDueFollowups(days: number, deps: FollowupDeps = realFollowupDeps): Judge[] {
  const done: Judge[] = [];
  for (const id of dueSessions(days, deps.now?.() ?? new Date())) {
    try {
      const j = followupSession(id, deps);
      if (j) done.push(j);
    } catch (err) {
      log(`followup ${id} failed: ${String(err)}`);
    }
  }
  const state = readJson<{ last_run?: string }>(followupStateFile(), {});
  state.last_run = new Date().toISOString();
  writeJson(followupStateFile(), state);
  return done;
}

export function judgeExists(session: string): boolean {
  return fs.existsSync(judgeFile(session));
}
