import type { Judge } from './schema.js';
import type { Config } from '../config.js';
import type { FetchDeps } from '../task/fetchers.js';
import { realDeps } from '../task/fetchers.js';
import { fmtUsd } from '../cost/pricing.js';

const ICON: Record<string, string> = { met: '✅', partial: '🟡', unmet: '❌', unverifiable: '❔' };

export function receiptComment(j: Judge): string {
  const L: string[] = [];
  L.push(`**Tally receipt** — ${j.verdict.verdict}${j.followup ? ` → after follow-up: ${j.followup.final_verdict} (${j.followup.final_status})` : ''}`);
  L.push('');
  L.push(`${j.completion_pct}% of acceptance criteria met · quality ${j.quality.score}/10 · ${fmtUsd(j.cost.total_usd)} API-equivalent (${j.cost.budget_used_pct}% of budget) · ROI ${j.value.roi_multiple === null ? 'n/a' : j.value.roi_multiple + '×'}`);
  L.push('');
  for (const c of j.criteria) L.push(`- ${ICON[c.status]} ${c.text}`);
  L.push('');
  L.push(`Independent check: ${j.verification.ran ? `\`${j.verification.command}\` ${j.verification.passed ? 'passed' : 'failed'}` : 'not run'} · waste ${fmtUsd(j.waste.total_usd)}`);
  L.push('');
  L.push('<sub>Generated locally by Tally. Contains no code or prompts.</sub>');
  return L.join('\n');
}

export interface WritebackResult {
  posted: Array<{ target: string; ok: boolean; detail?: string }>;
}

export async function writeBack(j: Judge, cfg: Config, deps: FetchDeps = realDeps): Promise<WritebackResult> {
  const body = receiptComment(j);
  const posted: WritebackResult['posted'] = [];
  const targets = new Set<string>();
  if (j.task.source.url) targets.add(j.task.source.url);
  for (const s of j.evidence.ship_events) if (s.url && /github\.com\/.+\/pull\/\d+/.test(s.url)) targets.add(s.url);

  for (const url of targets) {
    if (/github\.com\/[^/]+\/[^/]+\/(issues|pull)\/\d+/.test(url)) {
      const sub = /\/pull\//.test(url) ? 'pr' : 'issue';
      const r = deps.exec('gh', [sub, 'comment', url, '--body', body]);
      posted.push({ target: url, ok: r.ok, detail: r.ok ? undefined : r.stderr.trim().slice(0, 200) });
    } else if (/\/browse\/[A-Z][A-Z0-9]+-\d+/.test(url) || j.task.source.kind === 'jira') {
      const key = /([A-Z][A-Z0-9]+-\d+)/.exec(url)?.[1];
      const base = cfg.jira.base_url ?? new URL(url).origin;
      if (!key || !cfg.jira.email || !cfg.jira.api_token) {
        posted.push({ target: url, ok: false, detail: 'Jira credentials missing' });
        continue;
      }
      const auth = Buffer.from(`${cfg.jira.email}:${cfg.jira.api_token}`).toString('base64');
      const adf = { type: 'doc', version: 1, content: body.split('\n').map((line) => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line.replace(/[*`<>]/g, '') }] : [] })) };
      const r = await deps.fetch(`${base.replace(/\/$/, '')}/rest/api/3/issue/${key}/comment`, { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ body: adf }) });
      posted.push({ target: url, ok: r.ok, detail: r.ok ? undefined : `Jira ${r.status}` });
    } else if (/linear\.app\//.test(url)) {
      if (!cfg.linear.api_key) {
        posted.push({ target: url, ok: false, detail: 'LINEAR_API_KEY missing' });
        continue;
      }
      const ident = /issue\/([A-Z0-9]+-\d+)/.exec(url)?.[1];
      const headers = { Authorization: cfg.linear.api_key, 'Content-Type': 'application/json' };
      const lookup = await deps.fetch('https://api.linear.app/graphql', { method: 'POST', headers, body: JSON.stringify({ query: 'query($id: String!) { issue(id: $id) { id } }', variables: { id: ident } }) });
      const id = lookup.ok ? (JSON.parse(await lookup.text()) as { data?: { issue?: { id: string } } }).data?.issue?.id : undefined;
      if (!id) {
        posted.push({ target: url, ok: false, detail: 'Linear issue lookup failed' });
        continue;
      }
      const r = await deps.fetch('https://api.linear.app/graphql', { method: 'POST', headers, body: JSON.stringify({ query: 'mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }', variables: { issueId: id, body } }) });
      posted.push({ target: url, ok: r.ok, detail: r.ok ? undefined : `Linear ${r.status}` });
    }
  }
  return { posted };
}
