import { type Args, flag } from '../cli.js';
import { activeExperiment, loadExperiments, startExperiment, stopExperiment } from '../experiment/experiment.js';
import { buildReport, renderExperimentReport } from '../experiment/report.js';
import { repoKey } from '../paths.js';

export async function run(args: Args): Promise<number | void> {
  const sub = args._[0];
  const cwd = process.cwd();
  if (sub === 'start') {
    const kind = args._[1];
    const name = args._[2];
    const tasks = Number(flag(args, 'tasks') ?? 6);
    if ((kind !== 'skill' && kind !== 'mcp') || !name || !Number.isFinite(tasks) || tasks < 2) {
      process.stderr.write('Usage: tally experiment start <skill|mcp> <name> --tasks N\n');
      return 1;
    }
    const exp = startExperiment(cwd, kind, name, tasks);
    process.stdout.write(`Started experiment ${exp.id}: ${kind} "${name}" alternates off/on across the next ${tasks} tasks in this repo.\nThe next session starts with it ${exp.next_arm.toUpperCase()} (.claude/settings.local.json is patched now and restored byte-identically at each session end).\nRun \`tally experiment report\` after a few judged tasks.\n`);
    return;
  }
  if (sub === 'stop') {
    const exp = stopExperiment(cwd);
    process.stdout.write(exp ? `Stopped ${exp.id}; settings restored.\n` : 'No active experiment in this repo.\n');
    return;
  }
  if (sub === 'report' || sub === 'status' || !sub) {
    const key = repoKey(cwd);
    const all = loadExperiments().experiments.filter((e) => e.repo === key);
    const target = flag(args, 'id') ? all.find((e) => e.id === flag(args, 'id')) : activeExperiment(cwd) ?? all.at(-1);
    if (!target) {
      process.stdout.write('No experiments in this repo. Start one: tally experiment start <skill|mcp> <name> --tasks 6\n');
      return;
    }
    process.stdout.write(renderExperimentReport(buildReport(target)) + '\n');
    if (all.length > 1) process.stdout.write(`\n(${all.length} experiments in this repo; pass --id <id> for another)\n`);
    return;
  }
  process.stderr.write('Usage: tally experiment start|report|stop\n');
  return 1;
}
