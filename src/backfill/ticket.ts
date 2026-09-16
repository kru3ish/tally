/* The ticket as it read when the session started, where the tracker keeps history:
   Jira exposes a changelog (summary/description from → to); GitHub exposes title renames on the issue timeline and
   body edits through GraphQL userContentEdits. Otherwise the current text is used and the receipt says so. */
import type { Config } from '../config.js';
import type { FetchDeps, FetchedTask } from '../task/fetchers.js';
import { realDeps } from '../task/fetchers.js';

export interface TicketAsOf {
  title: string;
  body: string;
  as_of: 'current' | 'session_start';
  note: string;
}

export async function ticketAsOf(fetched: FetchedTask, sessionStart: string, cfg: Config, deps: FetchDeps = realDeps): Promise<TicketAsOf> {
  const current: TicketAsOf = { title: fetched.title, body: fetched.body, as_of: 'current', note: 'ticket text is the current version; it may have changed since the session' };
  try {
    if (fetched.source.kind === 'jira' && fetched.source.key && cfg.jira.base_url && cfg.jira.email && cfg.jira.api_token) return await jiraAsOf(fetched, sessionStart, cfg, deps, current);
    if (fetched.source.kind === 'github' && fetched.source.owner && fetched.source.repo && fetched.source.number) return await githubAsOf(fetched, sessionStart, deps, current);
  } catch (err) {
    return { ...current, note: `${current.note} (history lookup failed: ${err instanceof Error ? err.message : String(err)})` };
  }
  return current;
}

interface JiraChange {
  created: string;
  items?: Array<{ field?: string; fromString?: string | null; toString?: string | null }>;
}

async function jiraAsOf(fetched: FetchedTask, sessionStart: string, cfg: Config, deps: FetchDeps, current: TicketAsOf): Promise<TicketAsOf> {
  const auth = Buffer.from(`${cfg.jira.email}:${cfg.jira.api_token}`).toString('base64');
  const base = cfg.jira.base_url!.replace(/\/$/, '');
  const changes: JiraChange[] = [];
  let startAt = 0;
  for (let page = 0; page < 20; page++) {
    const r = await deps.fetch(`${base}/rest/api/3/issue/${fetched.source.key}/changelog?startAt=${startAt}&maxResults=100`, { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } });
    if (!r.ok) return { ...current, note: `${current.note} (Jira changelog ${r.status})` };
    const j = JSON.parse(await r.text()) as { values?: JiraChange[]; isLast?: boolean; total?: number };
    changes.push(...(j.values ?? []));
    if (j.isLast !== false || !j.values?.length) break;
    startAt += j.values.length;
  }
  const later = changes.filter((c) => c.created > sessionStart).sort((a, b) => b.created.localeCompare(a.created));
  let title = fetched.title;
  let body = fetched.body;
  let applied = 0;
  for (const c of later) {
    for (const it of c.items ?? []) {
      if (it.field === 'summary' && typeof it.fromString === 'string') {
        title = it.fromString;
        applied += 1;
      } else if (it.field === 'description' && typeof it.fromString === 'string') {
        body = it.fromString;
        applied += 1;
      }
    }
  }
  if (!applied) return { ...current, as_of: 'session_start', note: 'ticket unchanged since the session (Jira changelog)' };
  return { title, body, as_of: 'session_start', note: `ticket text reconstructed from the Jira changelog (${applied} later change(s) reverted)` };
}

async function githubAsOf(fetched: FetchedTask, sessionStart: string, deps: FetchDeps, current: TicketAsOf): Promise<TicketAsOf> {
  const { owner, repo, number } = fetched.source;
  const tl = deps.exec('gh', ['api', `repos/${owner}/${repo}/issues/${number}/timeline`, '--paginate', '--jq', '[.[] | select(.event == "renamed") | {created_at, from: .rename.from, to: .rename.to}]']);
  let title = fetched.title;
  let renames = 0;
  if (tl.ok) {
    try {
      const evs = (JSON.parse(tl.stdout.trim().replace(/\]\s*\[/g, ',')) as Array<{ created_at: string; from: string; to: string }>).filter((e) => e.created_at > sessionStart).sort((a, b) => b.created_at.localeCompare(a.created_at));
      for (const e of evs) {
        title = e.from;
        renames += 1;
      }
    } catch {
      /* ignore */
    }
  }
  const kind = fetched.source.is_pr ? 'pullRequest' : 'issue';
  const q = `query { repository(owner: "${owner}", name: "${repo}") { ${kind}(number: ${number}) { createdAt userContentEdits(first: 100) { nodes { editedAt diff } } } } }`;
  const ed = deps.exec('gh', ['api', 'graphql', '-f', `query=${q}`]);
  let body = fetched.body;
  let note = '';
  if (ed.ok) {
    try {
      const j = JSON.parse(ed.stdout) as { data?: { repository?: Record<string, { createdAt?: string; userContentEdits?: { nodes: Array<{ editedAt: string; diff: string | null }> } }> } };
      const node = j.data?.repository?.[kind];
      const edits = (node?.userContentEdits?.nodes ?? []).filter((e) => typeof e.diff === 'string').sort((a, b) => a.editedAt.localeCompare(b.editedAt));
      const before = edits.filter((e) => e.editedAt <= sessionStart);
      const after = edits.filter((e) => e.editedAt > sessionStart);
      if (before.length) {
        body = before[before.length - 1]!.diff ?? body;
        note = `body as of the last edit before the session (${before[before.length - 1]!.editedAt.slice(0, 10)})`;
      } else if (after.length) note = `body was edited ${after.length} time(s) after the session and the original text is not exposed by the API; current body used`;
      else note = 'body never edited';
    } catch {
      note = 'edit history unavailable';
    }
  } else note = 'edit history unavailable (gh api failed)';
  const asOf = renames || /as of the last edit|never edited/.test(note) ? 'session_start' : 'current';
  return { title, body, as_of: asOf, note: `${renames ? `title restored from ${renames} later rename(s); ` : ''}${note}` };
}
