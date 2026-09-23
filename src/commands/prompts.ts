/* `tally prompts`: what your best-scoring tasks' opening prompts had in common, from your own receipts. Compares
   the top and bottom halves by completion on a few plain features and offers a starting template. */
import { type Args, has } from '../cli.js';
import { loadHistory } from '../coach/context.js';
import { loadTask } from '../task/intake.js';
import { repoKey } from '../paths.js';

export interface PromptFeatures {
  names_test_command: boolean;
  lists_files: boolean;
  states_constraints: boolean;
  has_acceptance_list: boolean;
  links_ticket: boolean;
  length_words: number;
}

export function promptFeatures(text: string): PromptFeatures {
  return {
    names_test_command: /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test|pytest|go test|cargo test|make test|vitest|jest\b/i.test(text),
    lists_files: /[\w./-]+\.(ts|tsx|js|jsx|py|go|rs|java|rb|md|json|yml|yaml|css|html)\b/i.test(text),
    states_constraints: /\b(don't|do not|avoid|never|must not|keep .* unchanged|out of scope|only)\b/i.test(text),
    has_acceptance_list: /(^|\n)\s*(-|\*|\d+[.)])\s+\S/.test(text) || /acceptance|criteria|done when/i.test(text),
    links_ticket: /https?:\/\/\S+/.test(text),
    length_words: text.trim().split(/\s+/).filter(Boolean).length,
  };
}

const LABEL: Record<keyof Omit<PromptFeatures, 'length_words'>, string> = {
  names_test_command: 'names the test command',
  lists_files: 'names the files involved',
  states_constraints: 'says what not to change or what is out of scope',
  has_acceptance_list: 'lists acceptance points',
  links_ticket: 'links the ticket',
};

export function comparePrompts(samples: Array<{ text: string; completion: number }>): { n: number; findings: Array<{ feature: string; good_pct: number; poor_pct: number }>; template: string; median_words: { good: number; poor: number } } {
  const sorted = [...samples].sort((a, b) => b.completion - a.completion);
  const half = Math.floor(sorted.length / 2);
  const good = sorted.slice(0, half);
  const poor = sorted.slice(half);
  const pct = (xs: typeof samples, f: (p: PromptFeatures) => boolean) => (xs.length ? Math.round((xs.filter((x) => f(promptFeatures(x.text))).length / xs.length) * 100) : 0);
  const findings = (Object.keys(LABEL) as Array<keyof typeof LABEL>).map((k) => ({ feature: LABEL[k], good_pct: pct(good, (p) => p[k]), poor_pct: pct(poor, (p) => p[k]) })).sort((a, b) => b.good_pct - b.poor_pct - (a.good_pct - a.poor_pct));
  const median = (xs: typeof samples) => {
    const v = xs.map((x) => promptFeatures(x.text).length_words).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)]! : 0;
  };
  const winners = findings.filter((f) => f.good_pct > f.poor_pct).map((f) => f.feature);
  const template = ['<one line: what should be true when this is done>', '', 'Files: <the files or module involved>', 'Verify with: <the exact test or command>', 'Do not: <what must stay unchanged / out of scope>', 'Done when:', '- <acceptance point 1>', '- <acceptance point 2>'].join('\n');
  return { n: samples.length, findings, template: winners.length ? template : template, median_words: { good: median(good), poor: median(poor) } };
}

export async function run(args: Args): Promise<number | void> {
  const repo = has(args, 'all') ? undefined : repoKey(process.cwd());
  const receipts = loadHistory().filter((e) => e.verdict && !e.internal && e.session && (!repo || e.repo === repo));
  const samples: Array<{ text: string; completion: number }> = [];
  for (const r of receipts) {
    const t = loadTask(r.session!);
    const text = t?.body_excerpt || '';
    if (text.trim().length > 20) samples.push({ text, completion: r.completion_pct ?? 0 });
  }
  if (samples.length < 4) {
    process.stdout.write(`Need at least 4 receipts with a task text to compare (have ${samples.length}${repo ? ' in this repo; try --all' : ''}).\n`);
    return;
  }
  const c = comparePrompts(samples);
  process.stdout.write(`Your opening prompts, best half vs worst half by completion (n=${c.n}):\n`);
  for (const f of c.findings) process.stdout.write(`  ${f.feature.padEnd(48)} best ${String(f.good_pct).padStart(3)}%   worst ${String(f.poor_pct).padStart(3)}%${f.good_pct > f.poor_pct ? '   ← the good ones do this more' : ''}\n`);
  process.stdout.write(`  median length: best ${c.median_words.good} words, worst ${c.median_words.poor} words\n\nA starting template built from what worked for you:\n${c.template.split('\n').map((l) => '  ' + l).join('\n')}\n`);
}
