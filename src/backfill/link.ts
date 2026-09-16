/* Detects which ticket a past session was working on, in order of confidence:
   a URL in the prompts, an issue key in the branch or in commits made during the session, a PR whose commits fall in the window. */
import { spawnSync } from 'node:child_process';
import { ghStatus } from '../followup/gh.js';

export interface TaskLink {
  kind: 'url' | 'key' | 'pr' | 'none';
  ref: string;
  url?: string;
  confidence: number;
  evidence: string;
}

export interface LinkDeps {
  exec: (bin: string, args: string[], cwd: string) => { ok: boolean; stdout: string; stderr: string };
  ghOk: () => boolean;
}

export const realLinkDeps: LinkDeps = {
  exec: (bin, args, cwd) => {
    const r = spawnSync(bin, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  },
  ghOk: () => ghStatus().ok,
};

const URL_RE = /https?:\/\/(?:github\.com\/[^\s/]+\/[^\s/]+\/(?:issues|pull)\/\d+|[^\s/]+\.atlassian\.net\/browse\/[A-Z][A-Z0-9]+-\d+|linear\.app\/[^\s/]+\/issue\/[A-Z0-9]+-\d+)[^\s)>\]]*/g;
const KEY_RE = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g;
const HASH_RE = /(?:^|[\s(])#(\d{1,6})\b/g;

export function githubRemote(cwd: string, deps: LinkDeps = realLinkDeps): { owner: string; repo: string } | null {
  const r = deps.exec('git', ['remote', 'get-url', 'origin'], cwd);
  if (!r.ok) return null;
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\s*$/.exec(r.stdout.trim());
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

export function linkFromPrompts(prompts: string[]): TaskLink | null {
  for (const p of prompts) {
    const m = p.match(URL_RE);
    if (m?.length) return { kind: 'url', ref: m[0]!, url: m[0]!.replace(/[.,]+$/, ''), confidence: 0.9, evidence: 'URL in a prompt' };
  }
  return null;
}

export function keysIn(text: string): { keys: string[]; hashes: string[] } {
  const keys = [...new Set([...text.matchAll(KEY_RE)].map((m) => m[1]!).filter((k) => !/^(UTF|ISO|SHA|MD|RFC|CVE|HTTP|HTTPS|API|V|X|T)-?\d/.test(k)))];
  const hashes = [...new Set([...text.matchAll(HASH_RE)].map((m) => m[1]!))];
  return { keys, hashes };
}

export function commitsInWindow(cwd: string, branch: string | undefined, start: string, end: string, deps: LinkDeps = realLinkDeps): Array<{ sha: string; subject: string; body: string }> {
  const ref = branch ? [branch] : ['--all'];
  const r = deps.exec('git', ['log', ...ref, `--since=${start}`, `--until=${end}`, '--format=%H%x1f%s%x1f%b%x1e'], cwd);
  if (!r.ok) {
    if (branch) return commitsInWindow(cwd, undefined, start, end, deps);
    return [];
  }
  return r.stdout
    .split('\x1e')
    .map((rec) => rec.trim())
    .filter(Boolean)
    .map((rec) => {
      const [sha = '', subject = '', body = ''] = rec.split('\x1f');
      return { sha: sha.trim(), subject, body };
    });
}

export function detectTaskLink(input: { cwd?: string; branch?: string; prompts: string[]; start?: string; end?: string }, deps: LinkDeps = realLinkDeps): TaskLink {
  const fromPrompt = linkFromPrompts(input.prompts);
  if (fromPrompt) return fromPrompt;
  const cwd = input.cwd;
  if (!cwd) return { kind: 'none', ref: '', confidence: 0, evidence: 'no cwd recorded' };
  const remote = githubRemote(cwd, deps);
  const commits = input.start && input.end ? commitsInWindow(cwd, input.branch, input.start, input.end, deps) : [];
  const branchKeys = keysIn(input.branch ?? '');
  const commitText = commits.map((c) => `${c.subject}\n${c.body}`).join('\n');
  const commitKeys = keysIn(commitText);
  const key = branchKeys.keys[0] ?? commitKeys.keys[0];
  const hash = branchKeys.hashes[0] ?? commitKeys.hashes[0];
  if (key) {
    const where = branchKeys.keys[0] ? `branch "${input.branch}"` : `${commits.length} commit message(s) in the session window`;
    return { kind: 'key', ref: key, confidence: 0.6, evidence: `issue key in ${where}` };
  }
  if (hash && remote) {
    const where = branchKeys.hashes[0] ? `branch "${input.branch}"` : 'a commit message in the session window';
    return { kind: 'key', ref: `#${hash}`, url: `https://github.com/${remote.owner}/${remote.repo}/issues/${hash}`, confidence: 0.6, evidence: `#${hash} in ${where}` };
  }
  if (deps.ghOk() && input.branch && input.branch !== 'main' && input.branch !== 'master') {
    const r = deps.exec('gh', ['pr', 'list', '--state', 'all', '--head', input.branch, '--json', 'number,url,title,state', '--limit', '1'], cwd);
    if (r.ok) {
      try {
        const [pr] = JSON.parse(r.stdout) as Array<{ number: number; url: string; title: string; state: string }>;
        if (pr) return { kind: 'pr', ref: `#${pr.number}`, url: pr.url, confidence: 0.7, evidence: `PR "${pr.title}" (${pr.state}) from branch "${input.branch}" overlaps the session` };
      } catch {
        /* fall through */
      }
    }
  }
  const why = commits.length ? `${commits.length} commit(s) in the window but no issue key or PR found` : 'no URL in prompts, no commits in the session window';
  return { kind: 'none', ref: '', confidence: 0, evidence: why + (deps.ghOk() ? '' : ' (gh unavailable: PR lookup skipped)') };
}
