import fs from 'node:fs';
import path from 'node:path';
import { tallyHome, appendLine, ensureDir } from '../paths.js';
import { loadJudge } from '../judge/judge.js';
import type { Judge } from '../judge/schema.js';

export const STATUSES = ['met', 'partial', 'unmet', 'unverifiable'] as const;
export type Status = (typeof STATUSES)[number];
export const VERDICTS = ['worth it', 'borderline', 'not worth it'] as const;
export type VerdictText = (typeof VERDICTS)[number];

export interface CalibrationEntry {
  ts: string;
  session: string;
  source: 'human' | 'fixture';
  task_title: string;
  criteria: Array<{ id: string; text: string; judge: Status; human: Status; evidence: string }>;
  judge_verdict: VerdictText;
  human_verdict?: VerdictText;
  judge_model?: string;
}

export function calibrationFile(): string {
  return path.join(tallyHome(), 'calibration.jsonl');
}

export function parseStatuses(s: string): Status[] {
  return s
    .split(/[,\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
    .map((x) => {
      const m = STATUSES.find((st) => st === x || st.startsWith(x));
      if (!m) throw new Error(`unknown status "${x}" (use met, partial, unmet, unverifiable)`);
      return m;
    });
}

export function parseVerdict(s: string | undefined): VerdictText | undefined {
  if (!s) return undefined;
  const v = s.trim().toLowerCase().replace(/[_-]/g, ' ');
  const m = VERDICTS.find((x) => x === v || x.startsWith(v));
  if (!m) throw new Error(`unknown verdict "${s}" (use "worth it", "borderline", "not worth it")`);
  return m;
}

export function entryFromJudge(judge: Judge, human: Status[], humanVerdict: VerdictText | undefined, source: CalibrationEntry['source'] = 'human'): CalibrationEntry {
  if (human.length !== judge.criteria.length) throw new Error(`expected ${judge.criteria.length} grade(s) for ${judge.criteria.map((c) => c.id).join(', ')}, got ${human.length}`);
  return {
    ts: new Date().toISOString(),
    session: judge.session,
    source,
    task_title: judge.task.title,
    criteria: judge.criteria.map((c, i) => ({ id: c.id, text: c.text, judge: c.status, human: human[i]!, evidence: c.evidence })),
    judge_verdict: judge.verdict.verdict,
    human_verdict: humanVerdict,
    judge_model: judge.judge_model,
  };
}

export function addCalibration(session: string, human: Status[], humanVerdict?: VerdictText): CalibrationEntry {
  const judge = loadJudge(session);
  if (!judge) throw new Error(`no receipt for session ${session}; run tally judge first`);
  const entry = entryFromJudge(judge, human, humanVerdict);
  ensureDir(tallyHome());
  appendLine(calibrationFile(), JSON.stringify(entry));
  return entry;
}

export function readCalibration(file = calibrationFile()): CalibrationEntry[] {
  if (!fs.existsSync(file)) return [];
  const bySession = new Map<string, CalibrationEntry>();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as CalibrationEntry;
      bySession.set(e.session, e);
    } catch {
      /* skip */
    }
  }
  return [...bySession.values()];
}

export interface CalibrationReport {
  entries: number;
  criteria: number;
  criterion_agreement: number | null;
  strict_agreement: number | null;
  lenient_agreement: number | null;
  verdict_total: number;
  verdict_agreement: number | null;
  confusion: Record<Status, Record<Status, number>>;
  disagreements: Array<{ session: string; task: string; id: string; text: string; human: Status; judge: Status; evidence: string }>;
  verdict_disagreements: Array<{ session: string; task: string; human: VerdictText; judge: VerdictText }>;
  per_status: Record<Status, { human: number; judge: number; precision: number | null; recall: number | null }>;
}

const ORDER: Record<Status, number> = { met: 3, partial: 2, unverifiable: 1, unmet: 0 };

export function buildCalibrationReport(entries: CalibrationEntry[]): CalibrationReport {
  const confusion = Object.fromEntries(STATUSES.map((h) => [h, Object.fromEntries(STATUSES.map((j) => [j, 0]))])) as Record<Status, Record<Status, number>>;
  let total = 0;
  let agree = 0;
  let lenient = 0;
  const disagreements: CalibrationReport['disagreements'] = [];
  const vd: CalibrationReport['verdict_disagreements'] = [];
  let vTotal = 0;
  let vAgree = 0;
  for (const e of entries) {
    for (const c of e.criteria) {
      total += 1;
      confusion[c.human][c.judge] += 1;
      if (c.human === c.judge) {
        agree += 1;
        lenient += 1;
      } else {
        if (Math.abs(ORDER[c.human] - ORDER[c.judge]) === 1 && (c.human === 'partial' || c.judge === 'partial' || c.judge === 'unverifiable')) lenient += 1;
        disagreements.push({ session: e.session, task: e.task_title, id: c.id, text: c.text, human: c.human, judge: c.judge, evidence: c.evidence });
      }
    }
    if (e.human_verdict) {
      vTotal += 1;
      if (e.human_verdict === e.judge_verdict) vAgree += 1;
      else vd.push({ session: e.session, task: e.task_title, human: e.human_verdict, judge: e.judge_verdict });
    }
  }
  const per_status = {} as CalibrationReport['per_status'];
  for (const s of STATUSES) {
    const humanCount = STATUSES.reduce((n, j) => n + confusion[s][j], 0);
    const judgeCount = STATUSES.reduce((n, h) => n + confusion[h][s], 0);
    per_status[s] = { human: humanCount, judge: judgeCount, precision: judgeCount ? confusion[s][s] / judgeCount : null, recall: humanCount ? confusion[s][s] / humanCount : null };
  }
  return {
    entries: entries.length,
    criteria: total,
    criterion_agreement: total ? agree / total : null,
    strict_agreement: total ? agree / total : null,
    lenient_agreement: total ? lenient / total : null,
    verdict_total: vTotal,
    verdict_agreement: vTotal ? vAgree / vTotal : null,
    confusion,
    disagreements,
    verdict_disagreements: vd,
    per_status,
  };
}

export function renderCalibrationReport(r: CalibrationReport, title = 'Judge calibration'): string {
  const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
  const L: string[] = [];
  L.push(`${title}: ${r.entries} graded session(s), ${r.criteria} criteria`);
  if (!r.criteria) {
    L.push('No grades yet. Grade a receipt: tally calibrate add <session> --human met,partial,unmet,... --verdict "worth it"');
    return L.join('\n');
  }
  L.push(`criterion agreement   ${pct(r.criterion_agreement)} exact · ${pct(r.lenient_agreement)} within one step (partial/unverifiable neighbours)`);
  L.push(`verdict agreement     ${r.verdict_total ? `${pct(r.verdict_agreement)} of ${r.verdict_total}` : 'n/a (no human verdicts)'}`);
  L.push('');
  L.push('confusion (rows = human, columns = judge)');
  L.push(`${'human \\ judge'.padEnd(16)}${STATUSES.map((s) => s.padStart(13)).join('')}   recall`);
  for (const h of STATUSES) L.push(`${h.padEnd(16)}${STATUSES.map((j) => String(r.confusion[h][j]).padStart(13)).join('')}   ${pct(r.per_status[h].recall)}`);
  L.push(`${'precision'.padEnd(16)}${STATUSES.map((j) => pct(r.per_status[j].precision).padStart(13)).join('')}`);
  if (r.disagreements.length) {
    L.push('');
    L.push(`disagreements (${r.disagreements.length})`);
    for (const d of r.disagreements) L.push(`- [${d.session.slice(0, 12)}] ${d.id} "${d.text.slice(0, 70)}": human ${d.human}, judge ${d.judge}\n    judge's evidence: ${d.evidence.slice(0, 220).replace(/\n/g, ' ')}`);
  }
  if (r.verdict_disagreements.length) {
    L.push('');
    L.push('verdict disagreements');
    for (const d of r.verdict_disagreements) L.push(`- [${d.session.slice(0, 12)}] "${d.task.slice(0, 50)}": human ${d.human}, judge ${d.judge}`);
  }
  return L.join('\n');
}
