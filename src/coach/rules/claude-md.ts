import fs from 'node:fs';
import path from 'node:path';
import type { Rule, RuleContext, Suggestion } from '../types.js';
import { postTools } from '../helpers.js';

const IMPERATIVE = /\b(always|never|don'?t|do not|prefer|avoid|make sure|remember to|stop using|only use|use)\b/i;

export function instructionSentences(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/(?<=[.!\n])\s+|;\s+/)) {
    const s = raw.trim().replace(/[.!]+$/, '');
    const m = IMPERATIVE.exec(s);
    if (!m) continue;
    const from = s.slice(m.index).trim();
    if (from.length >= 12 && from.length <= 140) out.push(from);
  }
  return out;
}

function fingerprint(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

export function repeatedInstructions(prompts: string[], historyPrompts: string[] = []): Array<{ text: string; count: number }> {
  const seen = new Map<string, { text: string; count: number }>();
  const all = [...prompts.map((p) => ({ p, weight: 1 })), ...historyPrompts.map((p) => ({ p, weight: 1 }))];
  for (const { p } of all) {
    const uniq = new Set(instructionSentences(p).map(fingerprint));
    for (const fp of uniq) {
      const first = instructionSentences(p).find((s) => fingerprint(s) === fp)!;
      const cur = seen.get(fp) ?? { text: first, count: 0 };
      cur.count += 1;
      seen.set(fp, cur);
    }
  }
  return [...seen.values()].filter((x) => x.count >= 2).sort((a, b) => b.count - a.count);
}

export function detectStack(cwd: string): string[] {
  const has = (f: string) => fs.existsSync(path.join(cwd, f));
  const lines: string[] = [];
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
      const s = pkg.scripts ?? {};
      if (s.test) lines.push(`- Test: \`npm test\` (${s.test})`);
      if (s.build) lines.push(`- Build: \`npm run build\``);
      if (s.lint) lines.push(`- Lint: \`npm run lint\``);
      if (s.dev) lines.push(`- Dev server: \`npm run dev\``);
    } catch {
      /* ignore */
    }
  }
  if (has('pyproject.toml') || has('requirements.txt')) lines.push('- Python project: run tests with `python -m pytest -q`');
  if (has('go.mod')) lines.push('- Go: `go test ./...`');
  if (has('Cargo.toml')) lines.push('- Rust: `cargo test`');
  return lines;
}

export const claudeMd: Rule = {
  id: 'claude-md',
  describe: 'CLAUDE.md is missing, or the user keeps repeating the same instruction',
  evaluate(ctx: RuleContext) {
    const out: Suggestion[] = [];
    const prompts = ctx.events.filter((e) => e.type === 'prompt').map((e) => String(e.data.prompt ?? ''));
    const historyPrompts = ctx.history.filter((h) => h.repo === repoKeyOf(ctx.cwd) && Array.isArray(h.prompts)).flatMap((h) => h.prompts ?? []);
    const repeated = repeatedInstructions(prompts, historyPrompts);
    const claudeMdPath = path.join(ctx.cwd, 'CLAUDE.md');
    const existing = ctx.claudeMd ?? '';

    for (const r of repeated.slice(0, 2)) {
      if (existing.toLowerCase().includes(r.text.toLowerCase().slice(0, 40))) continue;
      out.push({
        rule: this.id,
        key: `repeated:${fingerprint(r.text)}`,
        severity: 'info',
        title: 'Instruction repeated',
        message: `You've told Claude "${r.text}" ${r.count} times. Put it in CLAUDE.md once and it sticks. (/insights shows the 30-day version of this.)`,
        usd_saved: ctx.avgTurnCostUsd * 0.5 * r.count,
        action: { kind: 'write_md', label: 'Append to CLAUDE.md', file: claudeMdPath, content: `\n- ${r.text}\n`, mode: 'append' },
      });
    }

    if (ctx.claudeMd === null && postTools(ctx).length >= 5) {
      const stack = detectStack(ctx.cwd);
      out.push({
        rule: this.id,
        key: 'missing-claude-md',
        severity: 'info',
        title: 'No CLAUDE.md in this repo',
        message: `This repo has no CLAUDE.md, so Claude rediscovers the stack and commands every session. A 10-line file saves the exploration turns. /init can draft one too.`,
        usd_saved: ctx.avgTurnCostUsd * 3,
        action: {
          kind: 'write_md',
          label: 'Create a starter CLAUDE.md',
          file: claudeMdPath,
          mode: 'create',
          content: `# ${path.basename(ctx.cwd)}\n\n## Commands\n${stack.length ? stack.join('\n') : '- (fill in test/build/lint commands)'}\n\n## Conventions\n- Run the tests before declaring a task done.\n- Keep changes scoped to the task; no drive-by refactors.\n`,
        },
      });
    }
    return out;
  },
};

function repoKeyOf(cwd: string): string {
  return cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
