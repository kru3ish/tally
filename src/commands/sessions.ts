import type { Args } from '../cli.js';
import { listSessions, readEvents } from '../store/events.js';
import { activeSessions } from '../session.js';
import { loadTask } from '../task/intake.js';
import { loadJudge } from '../judge/judge.js';
import { fmtUsd } from '../cost/pricing.js';

export async function run(_args: Args): Promise<void> {
  const active = new Set(activeSessions().map((s) => s.id));
  const ids = listSessions();
  if (!ids.length) {
    process.stdout.write('No sessions tracked yet.\n');
    return;
  }
  for (const id of ids.slice(0, 30)) {
    const ev = readEvents(id);
    const first = ev[0]?.ts ?? '';
    const cwd = ev.find((e) => e.cwd)?.cwd ?? '';
    const task = loadTask(id);
    const j = loadJudge(id);
    process.stdout.write(`${active.has(id) ? '●' : '○'} ${id.slice(0, 8)}  ${first.slice(0, 16)}  ${cwd}\n    ${task ? task.title : '(no task)'}${j ? `  → ${j.verdict.verdict}, ${j.completion_pct}% , ${fmtUsd(j.cost.total_usd)}${j.followup ? `, final: ${j.followup.final_status}` : ''}` : ''}\n`);
  }
}
