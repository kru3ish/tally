/* Feedback on Tally's own judgments, kept next to the receipt it is about. Everything here is local: a label per
   criterion (correct / wrong / unsure) with an optional comment in ~/.tally/sessions/<id>/feedback.jsonl, a count of
   real verifications for the one-time usefulness question, and that question's answer. Nothing leaves the machine
   unless telemetry is on, and telemetry only ever counts labels (see src/telemetry). */
import fs from 'node:fs';
import path from 'node:path';
import { appendLine, ensureDir, readJson, sessionDir, tallyHome, writeJson } from '../paths.js';
import { loadJudge } from '../judge/judge.js';
import { statusFromJudge } from '../assurance/index.js';
import type { Judge } from '../judge/schema.js';
import { record } from '../telemetry/index.js';

export const LABELS = ['correct', 'wrong', 'unsure'] as const;
export type FeedbackLabel = (typeof LABELS)[number];

export interface FeedbackEntry {
  ts: string;
  session: string;
  criterion: string;
  label: FeedbackLabel;
  comment?: string;
  /* what Tally had said, so the entry stands on its own when the receipt is later re-judged */
  judge_status: 'met' | 'partial' | 'unmet' | 'unverifiable';
  assurance: 'VERIFIED' | 'SUPPORTED' | 'UNVERIFIED' | 'UNMET';
  resolved_by: string;
  tally_version?: string;
  /* a wrong VERIFIED is the bug class the project treats as release-blocking */
  false_verified: boolean;
}

export function feedbackFile(session: string): string {
  return path.join(sessionDir(session), 'feedback.jsonl');
}

export function recordFeedback(session: string, criterion: string, label: FeedbackLabel, comment: string | undefined, version?: string): { entry: FeedbackEntry; judge: Judge } {
  const j = loadJudge(session);
  if (!j) throw new Error(`no receipt for session ${session}; run tally verify or tally judge first`);
  const c = j.criteria.find((x) => x.id === criterion);
  if (!c) throw new Error(`no criterion ${criterion} on this receipt (${j.criteria.map((x) => x.id).join(', ')})`);
  const assurance = j.assurance?.criteria.find((a) => a.id === criterion)?.status ?? statusFromJudge(c);
  const entry: FeedbackEntry = {
    ts: new Date().toISOString(),
    session,
    criterion,
    label,
    ...(comment?.trim() ? { comment: comment.trim().slice(0, 1000) } : {}),
    judge_status: c.override?.status ?? c.status,
    assurance,
    resolved_by: c.resolved_by,
    tally_version: version,
    false_verified: label === 'wrong' && assurance === 'VERIFIED',
  };
  ensureDir(sessionDir(session));
  appendLine(feedbackFile(session), JSON.stringify(entry));
  /* metrics (opt-in) count the label and whether it was a wrong VERIFIED; never the criterion or the comment */
  record({ command: 'feedback', success: true, feedback_label: label, false_verified: entry.false_verified });
  return { entry, judge: j };
}

export function readFeedback(session: string): FeedbackEntry[] {
  const f = feedbackFile(session);
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FeedbackEntry);
}

/* ---- the one-time usefulness question ---- */

export interface UsefulnessState {
  /* real (non-demo) verifications seen so far */
  verifications: number;
  asked?: string;
  answer?: 'yes' | 'no' | 'skip';
}

export function usefulnessFile(): string {
  return path.join(tallyHome(), 'usefulness.json');
}

export function readUsefulness(): UsefulnessState {
  return readJson<UsefulnessState>(usefulnessFile(), { verifications: 0 });
}

/* count a real verification; demo sessions and Tally's own internal runs never count */
export function countVerification(session: string): UsefulnessState {
  if (session.startsWith('demo-') || process.env.TALLY_INTERNAL === '1' || process.env.TALLY_LLM === 'stub') return readUsefulness();
  const s = readUsefulness();
  s.verifications += 1;
  ensureDir(tallyHome());
  writeJson(usefulnessFile(), s);
  return s;
}

export const USEFULNESS_AFTER = 5;
export const USEFULNESS_QUESTION = 'Has Tally caught something you would otherwise have missed? [y/n/skip] ';

/* whether to ask now: after the fifth real verification, once, only in an interactive terminal, never in CI */
export function shouldAskUsefulness(state: UsefulnessState, opts: { interactive: boolean; ci?: boolean }): boolean {
  if (!opts.interactive || opts.ci || process.env.CI) return false;
  if (state.asked) return false;
  return state.verifications >= USEFULNESS_AFTER;
}

export function recordUsefulness(answer: 'yes' | 'no' | 'skip'): UsefulnessState {
  const s = readUsefulness();
  s.asked = new Date().toISOString();
  s.answer = answer;
  ensureDir(tallyHome());
  writeJson(usefulnessFile(), s);
  record({ command: 'usefulness', success: true, usefulness_answer: answer });
  return s;
}

export function parseUsefulnessAnswer(raw: string): 'yes' | 'no' | 'skip' {
  const a = raw.trim().toLowerCase();
  if (a === 'y' || a === 'yes') return 'yes';
  if (a === 'n' || a === 'no') return 'no';
  return 'skip';
}
