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
  source: 'human' | 'fixture' | 'backfill';
  grader?: string;
  task_title: string;
  criteria: Array<{ id: string; text: string; judge: Status; human: Status; evidence: string }>;
  judge_verdict: VerdictText;
  human_verdict?: VerdictText;
  judge_model?: string;
  coach?: Array<{ rule: string; key: string; title: string; mark: 'useful' | 'noise' }>;
  task_source?: 'linked' | 'inferred' | 'confirmed';
  task_edited?: boolean;
  /* set when the judge side was refreshed from a newer receipt against the same human grades */
  rescored_from?: string;
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
    task_source: judge.task.task_source,
  };
}

/* Re-reads the current receipt for every graded backfill session and rewrites the judge side of the entry against
   the unchanged human grades (matched by criterion id). The human grades are never touched; a receipt whose criteria
   no longer match is skipped. Appends new entries, so the file keeps the history and the report uses the newest. */
export function rescoreCalibration(opts: { grader?: string; source?: CalibrationEntry['source'] } = {}): { rescored: string[]; skipped: Array<{ session: string; why: string }> } {
  const all = readCalibration().filter((e) => e.source === (opts.source ?? 'backfill') && (!opts.grader || (e.grader ?? '') === opts.grader));
  const latest = new Map<string, CalibrationEntry>();
  for (const e of all) latest.set(`${e.session}|${e.grader ?? ''}`, e);
  const rescored: string[] = [];
  const skipped: Array<{ session: string; why: string }> = [];
  for (const e of latest.values()) {
    const judge = loadJudge(e.session);
    if (!judge) {
      skipped.push({ session: e.session, why: 'no receipt' });
      continue;
    }
    const ids = judge.criteria.map((c) => c.id).join(',');
    if (ids !== e.criteria.map((c) => c.id).join(',')) {
      skipped.push({ session: e.session, why: `criteria changed (${ids})` });
      continue;
    }
    const unchanged = judge.criteria.every((c, i) => c.status === e.criteria[i]!.judge) && judge.verdict.verdict === e.judge_verdict;
    if (unchanged) continue;
    const fresh = entryFromJudge(judge, e.criteria.map((c) => c.human), e.human_verdict, e.source);
    const next: CalibrationEntry = { ...fresh, grader: e.grader, coach: e.coach, task_edited: e.task_edited, rescored_from: e.ts, criteria: fresh.criteria.map((c, i) => ({ ...c, text: e.criteria[i]!.text })) };
    appendLine(calibrationFile(), JSON.stringify(next));
    rescored.push(e.session);
  }
  return { rescored, skipped };
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
      bySession.set(`${e.session}|${e.grader ?? ''}`, e);
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
  lean: { lenient: number; stricter: number; same: number };
  inter_grader: { sessions: number; criteria: number; agreement: number | null; graders: string[] } | null;
  coach: { total: number; useful: number; precision: number | null; per_rule: Array<{ rule: string; total: number; useful: number; precision: number }> };
  by_task_source: Array<{ source: string; entries: number; criteria: number; agreement: number | null }>;
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
  const lean = { lenient: 0, stricter: 0, same: 0 };
  for (const e of entries)
    for (const c of e.criteria) {
      if (ORDER[c.judge] > ORDER[c.human]) lean.lenient += 1;
      else if (ORDER[c.judge] < ORDER[c.human]) lean.stricter += 1;
      else lean.same += 1;
    }
  const byGraderSession = new Map<string, CalibrationEntry[]>();
  for (const e of entries) if (e.grader) byGraderSession.set(e.session, [...(byGraderSession.get(e.session) ?? []), e]);
  let igCriteria = 0;
  let igAgree = 0;
  let igSessions = 0;
  const graders = new Set<string>();
  for (const [, es] of byGraderSession) {
    if (es.length < 2) continue;
    igSessions += 1;
    for (const e of es) graders.add(e.grader!);
    const [a, b] = es;
    for (let i = 0; i < Math.min(a!.criteria.length, b!.criteria.length); i++) {
      igCriteria += 1;
      if (a!.criteria[i]!.human === b!.criteria[i]!.human) igAgree += 1;
    }
  }
  const coachMarks = entries.flatMap((e) => e.coach ?? []);
  const perRule = new Map<string, { total: number; useful: number }>();
  for (const m of coachMarks) {
    const r = perRule.get(m.rule) ?? { total: 0, useful: 0 };
    r.total += 1;
    if (m.mark === 'useful') r.useful += 1;
    perRule.set(m.rule, r);
  }
  const by_task_source = ['linked', 'confirmed', 'inferred'].map((source) => {
    const es = entries.filter((e) => (e.task_source ?? 'linked') === source);
    const cs = es.flatMap((e) => e.criteria);
    return { source, entries: es.length, criteria: cs.length, agreement: cs.length ? cs.filter((c) => c.human === c.judge).length / cs.length : null };
  }).filter((x) => x.entries > 0);
  return {
    by_task_source,
    lean,
    inter_grader: igSessions ? { sessions: igSessions, criteria: igCriteria, agreement: igCriteria ? igAgree / igCriteria : null, graders: [...graders] } : null,
    coach: { total: coachMarks.length, useful: coachMarks.filter((m) => m.mark === 'useful').length, precision: coachMarks.length ? coachMarks.filter((m) => m.mark === 'useful').length / coachMarks.length : null, per_rule: [...perRule.entries()].map(([rule, v]) => ({ rule, total: v.total, useful: v.useful, precision: v.useful / v.total })).sort((x, y) => y.total - x.total) },
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
  L.push(`criterion agreement   ${pct(r.criterion_agreement)} exact · ${pct(r.lenient_agreement)} within one step (partial/unverifiable neighbours) · n=${r.criteria}`);
  L.push(`verdict agreement     ${r.verdict_total ? `${pct(r.verdict_agreement)} of ${r.verdict_total}` : 'n/a (no human verdicts)'} · n=${r.verdict_total}`);
  L.push(`lean                  Tally more lenient than the human on ${r.lean.lenient}, stricter on ${r.lean.stricter}, same on ${r.lean.same}`);
  if (r.inter_grader) L.push(`inter-grader          ${pct(r.inter_grader.agreement)} of ${r.inter_grader.criteria} criteria across ${r.inter_grader.sessions} session(s) graded by ${r.inter_grader.graders.join(' and ')}`);
  else L.push('inter-grader          n/a (no session graded by two people; use --grader <name>)');
  if (r.coach.total) {
    L.push(`coach precision       ${pct(r.coach.precision)} of ${r.coach.total} replayed suggestion(s) marked useful`);
    for (const p of r.coach.per_rule) L.push(`  ${p.rule.padEnd(22)} ${pct(p.precision)} (${p.useful}/${p.total})`);
  } else L.push('coach precision       n/a (no Coach suggestions graded)');
  if (r.by_task_source.length > 1) for (const s of r.by_task_source) L.push(`by task source        ${s.source.padEnd(10)} ${pct(s.agreement)} on ${s.criteria} criteria (${s.entries} session(s))`);
  L.push('');
  L.push('confusion (rows = human, columns = judge)');
  L.push(`${'human \\ judge'.padEnd(16)}${STATUSES.map((s) => s.padStart(13)).join('')}   recall`);
  for (const h of STATUSES) L.push(`${h.padEnd(16)}${STATUSES.map((j) => String(r.confusion[h][j]).padStart(13)).join('')}   ${pct(r.per_status[h].recall)}`);
  L.push(`${'precision'.padEnd(16)}${STATUSES.map((j) => pct(r.per_status[j].precision).padStart(13)).join('')}`);
  if (r.disagreements.length) {
    L.push('');
    L.push(`disagreements (${r.disagreements.length})`);
    for (const d of r.disagreements) L.push(`- [${d.session.slice(0, 12)}] ${d.id} "${d.text.slice(0, 70)}": human ${d.human}, judge ${d.judge} (${ORDER[d.judge] > ORDER[d.human] ? 'lenient' : 'stricter'})\n    judge's evidence: ${d.evidence.slice(0, 220).replace(/\n/g, ' ')}`);
  }
  if (r.verdict_disagreements.length) {
    L.push('');
    L.push('verdict disagreements');
    for (const d of r.verdict_disagreements) L.push(`- [${d.session.slice(0, 12)}] "${d.task.slice(0, 50)}": human ${d.human}, judge ${d.judge}`);
  }
  return L.join('\n');
}
