import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Config } from '../config.js';

export interface TaskSource {
  kind: 'github' | 'jira' | 'linear' | 'file' | 'text';
  ref: string;
  url?: string;
  owner?: string;
  repo?: string;
  number?: number;
  key?: string;
  is_pr?: boolean;
}

export interface FetchedTask {
  source: TaskSource;
  title: string;
  body: string;
  labels: string[];
  story_points?: number;
  state?: string;
  fetch_error?: string;
}

export interface FetchDeps {
  exec: (bin: string, args: string[]) => { ok: boolean; stdout: string; stderr: string };
  fetch: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
  readFile: (p: string) => string;
  exists: (p: string) => boolean;
}

export const realDeps: FetchDeps = {
  exec: (bin, args) => {
    const r = spawnSync(bin, args, { encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true, timeout: 30000 });
    return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  },
  fetch: async (url, init) => {
    const r = await fetch(url, init);
    return { ok: r.ok, status: r.status, text: () => r.text() };
  },
  readFile: (p) => fs.readFileSync(p, 'utf8'),
  exists: (p) => fs.existsSync(p),
};

const GH_RE = /https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)\/(issues|pull)\/(\d+)/;
const JIRA_RE = /https?:\/\/([^/\s]+)\/browse\/([A-Z][A-Z0-9]+-\d+)/;
const LINEAR_RE = /https?:\/\/linear\.app\/[^/\s]+\/issue\/([A-Z0-9]+-\d+)/;

export function classifyRef(ref: string, cwd: string, deps: FetchDeps = realDeps): TaskSource {
  const gh = GH_RE.exec(ref);
  if (gh) return { kind: 'github', ref, url: gh[0], owner: gh[1], repo: gh[2], number: Number(gh[4]), is_pr: gh[3] === 'pull' };
  const jira = JIRA_RE.exec(ref);
  if (jira) return { kind: 'jira', ref, url: jira[0], key: jira[2] };
  const lin = LINEAR_RE.exec(ref);
  if (lin) return { kind: 'linear', ref, url: lin[0], key: lin[1] };
  if (/^[A-Z][A-Z0-9]+-\d+$/.test(ref.trim())) return { kind: 'jira', ref, key: ref.trim() };
  if (/\.md$/i.test(ref.trim()) && !/\s/.test(ref.trim())) {
    const p = path.isAbsolute(ref.trim()) ? ref.trim() : path.resolve(cwd, ref.trim());
    if (deps.exists(p)) return { kind: 'file', ref: p };
  }
  return { kind: 'text', ref };
}

function storyPointsFrom(fields: Record<string, unknown>): number | undefined {
  for (const [k, v] of Object.entries(fields)) {
    if (/story.?points?|estimate/i.test(k) && typeof v === 'number') return v;
    if (k.startsWith('customfield_') && typeof v === 'number' && v > 0 && v <= 40 && /1001[0-9]|1002[0-9]/.test(k)) return v;
  }
  return undefined;
}

function adfToText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === 'text') return n.text ?? '';
  const inner = (n.content ?? []).map(adfToText).join('');
  if (n.type === 'paragraph' || n.type === 'heading' || n.type === 'listItem') return inner + '\n';
  return inner;
}

export async function fetchTask(ref: string, opts: { cwd: string; cfg: Config; deps?: FetchDeps; promptText?: string }): Promise<FetchedTask> {
  const deps = opts.deps ?? realDeps;
  const source = classifyRef(ref, opts.cwd, deps);
  const fallback = (err: string): FetchedTask => ({
    source: { ...source, kind: source.kind },
    title: firstLine(opts.promptText ?? ref),
    body: opts.promptText ?? ref,
    labels: [],
    fetch_error: err,
  });

  try {
    switch (source.kind) {
      case 'github': {
        const sub = source.is_pr ? 'pr' : 'issue';
        const r = deps.exec('gh', [sub, 'view', source.url!, '--json', 'title,body,labels,number,url,state']);
        if (!r.ok) return fallback(`gh ${sub} view failed: ${r.stderr.trim().slice(0, 200)}`);
        const j = JSON.parse(r.stdout) as { title: string; body: string; labels?: Array<{ name: string }>; state?: string };
        const labels = (j.labels ?? []).map((l) => l.name);
        const sp = labels.map((l) => /^(?:sp|points?)[:\s-]*(\d+)$/i.exec(l)?.[1]).find(Boolean);
        return { source, title: j.title, body: j.body ?? '', labels, state: j.state, story_points: sp ? Number(sp) : undefined };
      }
      case 'jira': {
        const base = opts.cfg.jira.base_url ?? (source.url ? new URL(source.url).origin : undefined);
        if (!base || !opts.cfg.jira.email || !opts.cfg.jira.api_token) return fallback('Jira not configured (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN)');
        const auth = Buffer.from(`${opts.cfg.jira.email}:${opts.cfg.jira.api_token}`).toString('base64');
        const r = await deps.fetch(`${base.replace(/\/$/, '')}/rest/api/3/issue/${source.key}`, { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } });
        if (!r.ok) return fallback(`Jira ${r.status}`);
        const j = JSON.parse(await r.text()) as { fields: Record<string, unknown> & { summary?: string; description?: unknown; labels?: string[]; status?: { name?: string } } };
        const desc = typeof j.fields.description === 'string' ? j.fields.description : adfToText(j.fields.description);
        return { source: { ...source, url: source.url ?? `${base}/browse/${source.key}` }, title: j.fields.summary ?? source.key!, body: desc, labels: j.fields.labels ?? [], state: j.fields.status?.name, story_points: storyPointsFrom(j.fields) };
      }
      case 'linear': {
        if (!opts.cfg.linear.api_key) return fallback('Linear not configured (LINEAR_API_KEY)');
        const r = await deps.fetch('https://api.linear.app/graphql', {
          method: 'POST',
          headers: { Authorization: opts.cfg.linear.api_key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: `query($id: String!) { issue(id: $id) { id identifier title description estimate url state { name } labels { nodes { name } } } }`, variables: { id: source.key } }),
        });
        if (!r.ok) return fallback(`Linear ${r.status}`);
        const j = JSON.parse(await r.text()) as { data?: { issue?: { title: string; description?: string; estimate?: number; url?: string; state?: { name: string }; labels?: { nodes: Array<{ name: string }> } } }; errors?: unknown };
        const issue = j.data?.issue;
        if (!issue) return fallback(`Linear returned no issue: ${JSON.stringify(j.errors ?? '').slice(0, 200)}`);
        return { source: { ...source, url: issue.url ?? source.url }, title: issue.title, body: issue.description ?? '', labels: (issue.labels?.nodes ?? []).map((l) => l.name), state: issue.state?.name, story_points: issue.estimate };
      }
      case 'file': {
        const body = deps.readFile(source.ref);
        const title = /^#\s+(.+)$/m.exec(body)?.[1] ?? path.basename(source.ref, '.md');
        return { source, title, body, labels: [] };
      }
      default:
        return { source, title: firstLine(ref), body: ref, labels: [] };
    }
  } catch (err) {
    return fallback(err instanceof Error ? err.message : String(err));
  }
}

function firstLine(s: string): string {
  const line = s.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? 'Untitled task';
  return line.length > 90 ? line.slice(0, 87) + '...' : line;
}
