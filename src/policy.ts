/* Repo policy: a `tally.json` at the repo root that an org commits. Standing criteria are appended to every task's
   frozen checklist (checked mechanically where possible); the budget block can override the rate, the budget fraction
   or set a fixed budget, and `hard_stop` turns the Coach's over-budget warning into a real stop: the PreToolUse hook
   denies tool calls until `tally budget approve` records an approval. */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { CheckSpecSchema } from './judge/checks.js';

export const PolicySchema = z.object({
  criteria: z.array(z.object({ text: z.string().min(1), check: CheckSpecSchema.optional() })).default([]),
  budget: z
    .object({
      hourly_rate: z.number().positive().optional(),
      fraction: z.number().positive().max(1).optional(),
      usd: z.number().positive().optional(),
      hard_stop: z.boolean().default(false),
    })
    .default({}),
  consent: z.boolean().optional(),
  /* the command the Judge runs for independent verification when `npm test` (or the detected runner) is not the right
     one for this repo: a pretest step that needs network, a monorepo, a suite that only works in CI */
  test_command: z.string().min(1).optional(),
  note: z.string().optional(),
});
export type Policy = z.infer<typeof PolicySchema>;

export const POLICY_FILES = ['tally.json', '.tally.json'];

export function policyFile(cwd: string): string | undefined {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 8; i++) {
    for (const name of POLICY_FILES) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
    if (fs.existsSync(path.join(dir, '.git'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export function loadPolicy(cwd: string | undefined): { policy: Policy; file?: string; error?: string } {
  if (!cwd) return { policy: PolicySchema.parse({}) };
  const file = policyFile(cwd);
  if (!file) return { policy: PolicySchema.parse({}) };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    const p = PolicySchema.safeParse(raw);
    if (!p.success) return { policy: PolicySchema.parse({}), file, error: p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
    return { policy: p.data, file };
  } catch (err) {
    return { policy: PolicySchema.parse({}), file, error: String(err) };
  }
}
