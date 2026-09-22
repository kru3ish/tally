/* `tally playbook [--all] [--write]`: the "Next time" lessons that keep recurring across receipts in this repo
   (or everywhere with --all), clustered by wording, with a CLAUDE.md snippet; --write appends the snippet. */
import fs from 'node:fs';
import path from 'node:path';
import { type Args, has } from '../cli.js';
import { loadHistory } from '../coach/context.js';
import { repoKey } from '../paths.js';
import type { HistoryEntry } from '../coach/types.js';

export interface Lesson {
  text: string;
  count: number;
  sessions: string[];
  repos: string[];
}

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'before', 'after', 'with', 'is', 'was', 'be', 'it', 'this', 'that', 'once', 'instead', 'again', 'each', 'every', 'not', 'rather', 'than']);

export function lessonKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/`[^`]*`/g, (m) => m.replace(/[^a-z0-9]/g, ''))
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    /* the first five content words: enough to merge rewordings of the same lesson, short enough to ignore trailing detail */
    .slice(0, 5)
    .join(' ');
}

export function clusterLessons(entries: HistoryEntry[], repo?: string): Lesson[] {
  const receipts = entries.filter((e) => e.verdict && !e.internal && (!repo || e.repo === repo));
  const by = new Map<string, Lesson>();
  for (const r of receipts) {
    for (const rec of r.recommendations ?? []) {
      const k = lessonKey(rec);
      if (!k) continue;
      const cur = by.get(k) ?? { text: rec, count: 0, sessions: [], repos: [] };
      cur.count += 1;
      if (r.session && !cur.sessions.includes(r.session)) cur.sessions.push(r.session);
      if (r.repo && !cur.repos.includes(r.repo)) cur.repos.push(r.repo);
      if (rec.length < cur.text.length) cur.text = rec;
      by.set(k, cur);
    }
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
}

export function playbookSnippet(lessons: Lesson[], n: number): string {
  const top = lessons.filter((l) => l.count >= 2).slice(0, 5);
  const pick = top.length ? top : lessons.slice(0, 3);
  return ['## Lessons from Tally receipts', `<!-- tally playbook: ${n} receipt(s); regenerate with \`tally playbook\` -->`, ...pick.map((l) => `- ${l.text}${l.count > 1 ? ` (seen ${l.count}×)` : ''}`), ''].join('\n');
}

export async function run(args: Args): Promise<number | void> {
  const repo = has(args, 'all') ? undefined : repoKey(process.cwd());
  const history = loadHistory();
  const lessons = clusterLessons(history, repo);
  const n = history.filter((e) => e.verdict && !e.internal && (!repo || e.repo === repo)).length;
  if (!lessons.length) {
    process.stdout.write(`No receipts with recommendations ${repo ? 'for this repo' : 'yet'}. Judge a few tasks first${repo ? ', or pass --all' : ''}.\n`);
    return;
  }
  process.stdout.write(`Recurring lessons across ${n} receipt(s)${repo ? ' in this repo' : ''}:\n`);
  for (const l of lessons.slice(0, 10)) process.stdout.write(`  ${String(l.count).padStart(3)}×  ${l.text}${!repo && l.repos.length > 1 ? `  (${l.repos.length} repos)` : ''}\n`);
  const snippet = playbookSnippet(lessons, n);
  process.stdout.write(`\nCLAUDE.md snippet:\n${snippet.split('\n').map((x) => '  ' + x).join('\n')}\n`);
  if (has(args, 'write')) {
    const file = path.join(process.cwd(), 'CLAUDE.md');
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const cleaned = existing.replace(/\n?## Lessons from Tally receipts[\s\S]*?(?=\n## |$)/, '').trimEnd();
    fs.writeFileSync(file, (cleaned ? cleaned + '\n\n' : '') + snippet);
    process.stdout.write(`Written to ${file}${existing ? ' (previous Tally section replaced, the rest untouched)' : ''}.\n`);
  } else process.stdout.write('Add it with: tally playbook --write\n');
}
