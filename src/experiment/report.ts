import { loadJudge } from '../judge/judge.js';
import type { Experiment } from './experiment.js';

export interface ArmStats {
  arm: 'on' | 'off';
  sessions: number;
  judged: number;
  completion_pct: number | null;
  cost_per_criterion_usd: number | null;
  rework_rate: number | null;
  followed_up: number;
}

export interface ExperimentReport {
  experiment: Experiment;
  arms: { on: ArmStats; off: ArmStats };
  enough_data: boolean;
  verdict: string;
  min_per_arm: number;
}

export const MIN_PER_ARM = 3;

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function armStats(exp: Experiment, arm: 'on' | 'off'): ArmStats {
  const sessions = exp.assignments.filter((a) => a.arm === arm);
  const judged = sessions.map((a) => loadJudge(a.session)).filter((j): j is NonNullable<typeof j> => !!j);
  const completion = judged.map((j) => j.completion_pct);
  const cpc = judged.map((j) => j.cost.per_completed_criterion_usd).filter((x): x is number => x !== null);
  const followed = judged.filter((j) => j.followup && j.followup.final_status !== 'unknown');
  const rework = followed.map((j) => (j.followup!.final_status === 'held up' ? 0 : 1));
  return {
    arm,
    sessions: sessions.length,
    judged: judged.length,
    completion_pct: mean(completion),
    cost_per_criterion_usd: mean(cpc),
    rework_rate: mean(rework),
    followed_up: followed.length,
  };
}

export function buildReport(exp: Experiment): ExperimentReport {
  const on = armStats(exp, 'on');
  const off = armStats(exp, 'off');
  const enough = on.judged >= MIN_PER_ARM && off.judged >= MIN_PER_ARM;
  let verdict: string;
  if (!enough) {
    verdict = `not enough data: ${on.judged} judged task(s) with ${exp.name} on, ${off.judged} off; need at least ${MIN_PER_ARM} each. ${Math.max(0, exp.tasks_total - exp.assignments.length)} task(s) still to run.`;
  } else {
    const dComp = (on.completion_pct ?? 0) - (off.completion_pct ?? 0);
    const dCost = on.cost_per_criterion_usd !== null && off.cost_per_criterion_usd !== null ? on.cost_per_criterion_usd - off.cost_per_criterion_usd : null;
    const parts = [`completion ${dComp >= 0 ? '+' : ''}${dComp.toFixed(1)} pts with it on`];
    if (dCost !== null) parts.push(`cost per criterion ${dCost >= 0 ? '+' : ''}$${dCost.toFixed(2)}`);
    if (on.rework_rate !== null && off.rework_rate !== null) parts.push(`rework ${((on.rework_rate - off.rework_rate) * 100).toFixed(0)} pts`);
    const helps = dComp > 5 || (dCost !== null && dCost < -0.5 && dComp >= -2);
    const hurts = dComp < -5 || (dCost !== null && dCost > 0.5 && dComp <= 2);
    verdict = `${helps ? `${exp.name} appears to help` : hurts ? `${exp.name} appears to hurt` : `no clear difference from ${exp.name}`} (${parts.join(', ')}; n=${on.judged}+${off.judged}, small samples are noisy).`;
  }
  return { experiment: exp, arms: { on, off }, enough_data: enough, verdict, min_per_arm: MIN_PER_ARM };
}

export function renderExperimentReport(r: ExperimentReport): string {
  const f = (x: number | null, suffix = '', digits = 1) => (x === null ? 'n/a' : `${x.toFixed(digits)}${suffix}`);
  const L: string[] = [];
  L.push(`Experiment: ${r.experiment.kind} "${r.experiment.name}" · ${r.experiment.assignments.length}/${r.experiment.tasks_total} tasks assigned${r.experiment.stopped_at ? ' (stopped)' : ''}`);
  L.push('');
  L.push(`arm   sessions  judged  completion  cost/criterion  rework`);
  for (const a of [r.arms.on, r.arms.off]) L.push(`${a.arm.padEnd(5)} ${String(a.sessions).padStart(8)}  ${String(a.judged).padStart(6)}  ${f(a.completion_pct, '%').padStart(10)}  ${(a.cost_per_criterion_usd === null ? 'n/a' : '$' + a.cost_per_criterion_usd.toFixed(2)).padStart(14)}  ${a.rework_rate === null ? 'n/a' : `${(a.rework_rate * 100).toFixed(0)}% (${a.followed_up} followed up)`}`);
  L.push('');
  L.push(r.verdict);
  return L.join('\n');
}
