/* `tally eval discover`: find public issues that make good evaluation tasks and write them as candidate specs for a
   person (or a later Claude pass) to curate into eval/tasks/. Selection is scored and every reason is recorded, so the
   corpus cannot quietly drift toward tasks Tally does well on. Read-only against GitHub; never posts. */
import fs from 'node:fs';
import path from 'node:path';
import type { EvalTask } from './tasks.js';

export interface Candidate {
  spec: EvalTask;
  score: number;
  reasons: string[];
  title: string;
  comments: number;
  updated: string;
}

interface Issue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  comments: number;
  updated_at: string;
  labels: Array<{ name: string }>;
  pull_request?: unknown;
}

/* Heuristics a person would apply, made explicit: a reproduction, a stated expectation, no external service, small. */
export function scoreIssue(i: Issue, repo: { tests: boolean; language?: string }): { score: number; reasons: string[] } {
  const body = i.body ?? '';
  const reasons: string[] = [];
  let score = 0;
  if (body.length > 200) {
    score += 2;
    reasons.push('describes the problem in more than a sentence');
  }
  if (/```/.test(body)) {
    score += 3;
    reasons.push('has a code block (likely a reproduction)');
  }
  if (/\b(expected|should|instead)\b/i.test(body)) {
    score += 2;
    reasons.push('states expected behaviour');
  }
  if (repo.tests) {
    score += 2;
    reasons.push('repository has a test script');
  }
  if (i.comments <= 8) {
    score += 1;
    reasons.push('short discussion, so the task is not settled by the thread');
  }
  if (/\b(docker|kubernetes|aws|gcp|azure|s3|redis|postgres|mysql|oauth|credentials|api key)\b/i.test(body)) {
    score -= 3;
    reasons.push('mentions external infrastructure or credentials');
  }
  if (/\b(design|proposal|rfc|discussion|roadmap|question)\b/i.test(i.title)) {
    score -= 3;
    reasons.push('title reads as a discussion, not a task');
  }
  if (body.length > 6000) {
    score -= 1;
    reasons.push('very long issue');
  }
  if (i.labels.some((l) => /\b(bug|regression)\b/i.test(l.name))) {
    score += 1;
    reasons.push('labelled bug');
  }
  return { score, reasons };
}

async function gh<T>(url: string, token?: string): Promise<T> {
  const r = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'tally-eval', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return (await r.json()) as T;
}

export async function discover(opts: { repos: string[]; limit?: number; token?: string; out?: (s: string) => void }): Promise<Candidate[]> {
  const out = opts.out ?? (() => {});
  const token = opts.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const found: Candidate[] = [];
  for (const repo of opts.repos) {
    let pkgTests = false;
    let language: string | undefined;
    try {
      const meta = await gh<{ language?: string; default_branch: string }>(`https://api.github.com/repos/${repo}`, token);
      language = meta.language;
      try {
        const pkg = await gh<{ content?: string }>(`https://api.github.com/repos/${repo}/contents/package.json`, token);
        if (pkg.content) pkgTests = !!(JSON.parse(Buffer.from(pkg.content, 'base64').toString('utf8')) as { scripts?: Record<string, string> }).scripts?.test;
      } catch {
        pkgTests = false;
      }
    } catch (err) {
      out(`  ${repo}: ${String(err)}`);
      continue;
    }
    const q = encodeURIComponent(`repo:${repo} is:issue is:open label:bug`);
    let items: Issue[] = [];
    try {
      items = (await gh<{ items: Issue[] }>(`https://api.github.com/search/issues?q=${q}&sort=updated&per_page=${opts.limit ?? 10}`, token)).items;
    } catch (err) {
      out(`  ${repo}: search failed: ${String(err)}`);
      continue;
    }
    for (const i of items) {
      if (i.pull_request) continue;
      const { score, reasons } = scoreIssue(i, { tests: pkgTests, language });
      const id = `${repo.replace('/', '-')}-${i.number}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      found.push({
        title: i.title,
        comments: i.comments,
        updated: i.updated_at,
        score,
        reasons,
        spec: { id, class: 'real', repo: `https://github.com/${repo}.git`, issue: i.html_url, task: `# ${i.title}\n\nGitHub issue: ${i.html_url}\n\n## Issue as reported\n\n${(i.body ?? '').replace(/\r/g, '').trim()}\n\n## Acceptance criteria\n\n- (write them from the issue before running)\n`, setup: pkgTests ? ['npm install --no-audit --no-fund --loglevel=error'] : [], tags: [language?.toLowerCase() ?? 'unknown', 'bug'], selected_because: `score ${score}: ${reasons.join('; ')}`, contamination: 'possible', contamination_note: 'open issue; a fix may exist in a fork or a later commit', added: new Date().toISOString().slice(0, 10) },
      });
    }
    out(`  ${repo}: ${items.length} open bug(s) considered`);
  }
  return found.sort((a, b) => b.score - a.score);
}

export function writeCandidates(cands: Candidate[], dir: string): string[] {
  fs.mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  for (const c of cands) {
    const f = path.join(dir, `${c.spec.id}.json`);
    fs.writeFileSync(f, JSON.stringify({ ...c.spec, _candidate: { score: c.score, reasons: c.reasons, title: c.title, comments: c.comments, updated: c.updated } }, null, 2) + '\n');
    files.push(f);
  }
  return files;
}
