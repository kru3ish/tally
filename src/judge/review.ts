/* Maintainer review: the pass a criteria-and-tests Judge cannot do. Both verdict misses in the real-issue eval were
   fixes that met every criterion with a green suite and that a maintainer would still send back: one patched express
   around a bug in the `router` dependency, one changed how micromatch compiles patterns the suite never covers. This
   tier reads the diff as a reviewer: is the fix where the bug lives, what else does the touched code serve, and what
   changed that no test exercises. It runs on library-shaped repos (auto) or always (on), and can cap `worth it` at
   `borderline` with the reason on the receipt. It never raises a verdict. */
import fs from 'node:fs';
import path from 'node:path';
import type { Task } from '../task/intake.js';
import type { Evidence } from './evidence.js';
import type { VerificationResult } from './verify.js';
import type { LlmClient } from '../llm/client.js';
import { trimDiff } from './tiers.js';

export interface Review {
  ran: boolean;
  reason?: string;
  layer?: 'at_root_cause' | 'workaround' | 'unclear';
  layer_note?: string;
  blast_radius?: 'none' | 'contained' | 'wide' | 'unclear';
  blast_note?: string;
  untested_surface?: string[];
  merge?: 'merge' | 'request_changes' | 'unclear';
  note?: string;
  model?: string;
  cost_usd?: number;
}

export const REVIEW_SYSTEM = `You are the maintainer of this repository reviewing a change made by a coding agent. The acceptance criteria have already been scored by someone else; do not re-score them. Your job is the part criteria cannot see:
1. layer: is the fix where the bug lives? "workaround" means the change patches around behaviour that lives elsewhere (a dependency, another module, a caller) so the symptom goes away but the cause remains, or the same bug is still reachable by another path.
2. blast_radius: what else does the touched code serve? "wide" means public API or shared behaviour changed in ways the task did not ask for; "contained" means only the requested behaviour changed; "none" means an additive change.
3. untested_surface: behaviours this diff changes that no test in the diff exercises. Name them concretely (an input shape, a pattern, an option), not generically.
4. merge: would you merge this with minor review ("merge"), or send it back ("request_changes")? Send it back only for a real defect in layer or blast radius, or an untested change that plausibly alters behaviour for other users. Style is never a reason.
Be specific, cite file names and lines from the diff, and return only the JSON object.`;

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    layer: { type: 'string', enum: ['at_root_cause', 'workaround', 'unclear'] },
    layer_note: { type: 'string' },
    blast_radius: { type: 'string', enum: ['none', 'contained', 'wide', 'unclear'] },
    blast_note: { type: 'string' },
    untested_surface: { type: 'array', items: { type: 'string' } },
    merge: { type: 'string', enum: ['merge', 'request_changes', 'unclear'] },
    note: { type: 'string' },
  },
  required: ['layer', 'layer_note', 'blast_radius', 'blast_note', 'untested_surface', 'merge', 'note'],
} as const;

/* A repo other people depend on: a non-private package with an entry point, a crate, or a Python package. */
export function looksLikeLibrary(cwd: string): boolean {
  try {
    const pj = path.join(cwd, 'package.json');
    if (fs.existsSync(pj)) {
      const p = JSON.parse(fs.readFileSync(pj, 'utf8')) as { private?: boolean; main?: string; exports?: unknown; bin?: unknown; types?: string; module?: string };
      if (p.private === true) return false;
      return !!(p.main || p.exports || p.bin || p.types || p.module);
    }
    if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) return /\[lib\]|^\s*name\s*=/m.test(fs.readFileSync(path.join(cwd, 'Cargo.toml'), 'utf8'));
    if (fs.existsSync(path.join(cwd, 'pyproject.toml'))) return /\[project\]|\[tool\.poetry\]/.test(fs.readFileSync(path.join(cwd, 'pyproject.toml'), 'utf8'));
  } catch {
    return false;
  }
  return false;
}

export function shouldReview(mode: 'auto' | 'on' | 'off', cwd: string, ev: Evidence): boolean {
  if (mode === 'off') return false;
  const hasDiff = !!(ev.git.diff_excerpt || ev.reconstruction.diff_text);
  if (!hasDiff) return false;
  const nonTest = ev.git.files_changed.some((f) => !/(^|\/)(test|tests|__tests__|spec)\//i.test(f) && !/\.(test|spec)\.[jt]sx?$/i.test(f) && !/\.md$/i.test(f));
  if (!nonTest) return false;
  return mode === 'on' || looksLikeLibrary(cwd);
}

export function buildReviewPrompt(task: Task, ev: Evidence, ver: VerificationResult, cwd: string, tokenBudget: number): string {
  let manifest = '';
  try {
    const pj = path.join(cwd, 'package.json');
    if (fs.existsSync(pj)) {
      const p = JSON.parse(fs.readFileSync(pj, 'utf8')) as { name?: string; description?: string; dependencies?: Record<string, string>; main?: string; exports?: unknown };
      manifest = `# PACKAGE\n${p.name ?? ''}: ${p.description ?? ''}\nentry: ${p.main ?? (p.exports ? 'exports map' : '?')}\ndependencies: ${Object.keys(p.dependencies ?? {}).join(', ') || 'none'}\n`;
    }
  } catch {
    manifest = '';
  }
  const head = [`# TASK\n${task.title}`, `## Criteria (already scored; for context only)`, ...task.criteria.map((c) => `- ${c.id}: ${c.text}`), '', manifest, `# FILES CHANGED (${ev.git.files_changed.length}): ${ev.git.files_changed.join(', ')}`, `# TESTS: ${ver.ran ? `${ver.command} → ${ver.passed ? 'passed' : 'FAILED'}` : 'not run'}`, ''].join('\n');
  const source = ev.git.diff_excerpt || ev.reconstruction.diff_text || '(empty diff)';
  const { text } = trimDiff(source, ev.edited_files, Math.max(2000, tokenBudget * 4 - head.length - 400));
  return `${head}\n# DIFF\n${text}\n\nReview this as the maintainer.`;
}

export async function maintainerReview(opts: { task: Task; ev: Evidence; ver: VerificationResult; cwd: string; llm: LlmClient; model: string; tokenBudget: number }): Promise<Review> {
  const prompt = buildReviewPrompt(opts.task, opts.ev, opts.ver, opts.cwd, opts.tokenBudget);
  try {
    const r = await opts.llm.complete<Omit<Review, 'ran' | 'model' | 'cost_usd'>>({ kind: 'review', model: opts.model, system: REVIEW_SYSTEM, prompt, schema: REVIEW_SCHEMA as unknown as Record<string, unknown>, timeoutMs: 240000 });
    const d = r.data ?? {};
    const pick = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T => (allowed.includes(v as T) ? (v as T) : dflt);
    return {
      ran: true,
      layer: pick(d.layer, ['at_root_cause', 'workaround', 'unclear'] as const, 'unclear'),
      layer_note: String(d.layer_note ?? '').slice(0, 600),
      blast_radius: pick(d.blast_radius, ['none', 'contained', 'wide', 'unclear'] as const, 'unclear'),
      blast_note: String(d.blast_note ?? '').slice(0, 600),
      untested_surface: (Array.isArray(d.untested_surface) ? d.untested_surface : []).map(String).slice(0, 8),
      merge: pick(d.merge, ['merge', 'request_changes', 'unclear'] as const, 'unclear'),
      note: String(d.note ?? '').slice(0, 800),
      model: r.model,
      cost_usd: r.cost_usd,
    };
  } catch (err) {
    return { ran: false, reason: `review unavailable: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}` };
  }
}

/* The cap: a reviewer who would send the change back keeps it from being `worth it`. */
export function reviewCaps(review: Review | undefined): boolean {
  return !!review?.ran && review.merge === 'request_changes';
}

export function renderReview(review: Review): string[] {
  if (!review.ran) return [`Maintainer review: not run (${review.reason ?? 'off'})`];
  const L = [`Maintainer review (${review.model ?? 'model'}): ${review.merge === 'merge' ? 'would merge with minor review' : review.merge === 'request_changes' ? 'would REQUEST CHANGES' : 'unclear'}`];
  L.push(`  layer: ${review.layer}${review.layer_note ? ' — ' + review.layer_note : ''}`);
  L.push(`  blast radius: ${review.blast_radius}${review.blast_note ? ' — ' + review.blast_note : ''}`);
  if (review.untested_surface?.length) L.push(`  changed but untested: ${review.untested_surface.join('; ')}`);
  if (review.note) L.push(`  ${review.note}`);
  return L;
}
