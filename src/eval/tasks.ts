/* Evaluation task specs. Three classes, kept apart in every report:

     fixture     a constructed repository (deterministic; CI)
     real        a public issue solved in an isolated clone of the current repository
     historical  a public issue solved at the commit before the human fix, so the later human patch and outcome are
                 external evidence about intended behaviour (never the only valid implementation)

   A spec is one JSON file under eval/tasks/. It says where the repository comes from, which commit is the base, what
   the agent is told, what Tally will freeze as criteria (or lets intake extract them), how the suite is run here, why
   the task was selected, and whether the solution is likely to be in model training data. */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const EvalTaskSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  class: z.enum(['fixture', 'real', 'historical']),
  /* a git URL, or a local path (absolute, or relative to the spec file) */
  repo: z.string(),
  /* commit to start from; omit for a local fixture whose HEAD is the base */
  base: z.string().optional(),
  /* the issue this came from, for the record */
  issue: z.string().optional(),
  /* the task as the agent sees it: markdown text, or a path to a .md file relative to the spec */
  task: z.string(),
  /* criteria Tally freezes verbatim (source explicit); when absent intake extracts them from the task text */
  criteria: z.array(z.object({ text: z.string(), check: z.record(z.unknown()).optional() })).optional(),
  /* what runs the suite on this machine when the detected runner is wrong (becomes tally.json test_command) */
  test_command: z.string().optional(),
  /* commands to run once after cloning (npm install and the like); recorded, never network-free by assumption */
  setup: z.array(z.string()).default([]),
  /* language / framework / kind, for slicing results */
  tags: z.array(z.string()).default([]),
  /* why this task is in the corpus, in a sentence */
  selected_because: z.string(),
  /* the later human fix, for historical tasks: a commit or PR the agent must never see */
  human_fix: z.string().optional(),
  /* honest note on whether the solution is likely in model training data */
  contamination: z.enum(['unlikely', 'possible', 'likely']).default('possible'),
  contamination_note: z.string().optional(),
  added: z.string(),
});
export type EvalTask = z.infer<typeof EvalTaskSchema>;

export function tasksRoot(root = process.cwd()): string {
  return path.join(root, 'eval', 'tasks');
}

export function loadTasks(dir = tasksRoot()): Array<EvalTask & { file: string; repoPath?: string; taskText: string }> {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const file = path.join(dir, f);
      const spec = EvalTaskSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
      const isLocal = !/^(https?:|git@|ssh:)/.test(spec.repo);
      const repoPath = isLocal ? path.resolve(path.dirname(file), spec.repo) : undefined;
      const taskText = spec.task.endsWith('.md') && fs.existsSync(path.resolve(path.dirname(file), spec.task)) ? fs.readFileSync(path.resolve(path.dirname(file), spec.task), 'utf8') : spec.task;
      return { ...spec, file, repoPath, taskText };
    });
}
