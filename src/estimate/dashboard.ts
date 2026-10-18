/* The cost dashboard: one self-contained HTML page (inline CSS and SVG, no scripts from anywhere, no network) built
   from the repo's ledger and, when given, the story just finished. Written to a temp file and opened in the browser
   by `tally dashboard`, `/tally:cost`, `tally estimate --open`, and at the end of an interactive session. */
import type { LedgerEntry } from './ledger.js';
import type { CostCheck } from './variance.js';
import type { CostEstimate } from './estimate.js';
import { quantile } from './estimate.js';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const $ = (n: number | undefined) => (n === undefined ? '–' : n >= 100 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

const DRIVER_NAMES: Record<string, string> = {
  model: 'Expensive main model',
  subagents: 'Subagents on an expensive model',
  retries: 'Failing commands retried',
  rereads: 'Files re-read',
  context: 'Tools loaded, never used',
  'long-context': 'One long conversation',
  compaction: 'Compactions',
  scout: 'Haiku scout subagent for exploring',
  docs: 'Context7 MCP for library docs',
  'big-reads': 'Serena MCP to read code by symbol',
  'noisy-tests': 'run-tests skill with a quiet reporter',
  'mcp-output': 'Cap MCP tool output',
  effort: 'Lower default effort',
  'story-skill': 'Project skill from a finished story',
};

function statusOf(e: { status: string }): { cls: string; label: string } {
  if (e.status === 'over') return { cls: 'over', label: 'over' };
  if (e.status === 'under') return { cls: 'under', label: 'under' };
  if (e.status === 'on_target') return { cls: 'on', label: 'on target' };
  return { cls: 'none', label: 'no estimate' };
}

function currentCard(c: CostCheck, cli: string): string {
  const e = c.estimate && c.estimate.basis !== 'none' && c.estimate.basis !== 'all' ? c.estimate : undefined;
  const st = statusOf(c);
  const max = Math.max(c.actual_usd, e?.high_usd ?? 0, e?.usd ?? 0) * 1.1 || 1;
  const pct = (n: number) => `${Math.min(100, (n / max) * 100).toFixed(1)}%`;
  const fixes = new Map<string, NonNullable<CostCheck['drivers'][number]['fix']>>();
  for (const d of c.drivers) if (d.fix && !fixes.has(d.fix.id)) fixes.set(d.fix.id, d.fix);
  const dmax = Math.max(...c.drivers.map((d) => d.usd), 0.01);
  const row = (d: CostCheck['drivers'][number]) => `<div class="drow"><div class="dname">${esc(d.title)}${d.basis === 'estimated' ? ' <span class="muted">(estimate)</span>' : ''}<div class="ddet">${esc(d.detail)}</div></div><div class="dbar"><div style="width:${((d.usd / dmax) * 100).toFixed(1)}%"></div></div><div class="dval">${$(d.usd)}</div></div>`;
  const waste = c.drivers.filter((d) => d.group !== 'add');
  const adds = c.drivers.filter((d) => d.group === 'add');
  return `<section class="card hero">
  <div class="eyebrow">This story</div>
  <h2>${esc(c.task?.split('\n')[0]?.slice(0, 120) ?? 'Untitled story')}</h2>
  <div class="nums">
    <div><div class="k">Estimate</div><div class="v">${e ? $(e.usd) : '–'}</div><div class="s">${e ? `${$(e.low_usd)}–${$(e.high_usd)} · ${e.basis === 'similar' ? `${e.n} similar ${e.n === 1 ? 'story' : 'stories'}` : e.basis === 'points' ? 'story points' : 'repo median'} · ${e.confidence}` : 'no similar story yet'}</div></div>
    <div><div class="k">Actual</div><div class="v">${$(c.actual_usd)}</div><div class="s">${esc(c.model)}</div></div>
    <div><div class="k">Difference</div><div class="v ${st.cls}">${c.delta_usd === undefined ? '–' : `${c.delta_usd >= 0 ? '+' : '−'}${$(Math.abs(c.delta_usd))}`}</div><div class="s">${c.delta_pct === undefined ? st.label : `${c.delta_pct >= 0 ? '+' : ''}${c.delta_pct}% · ${st.label}`}</div></div>
    <div><div class="k">Avoidable next time</div><div class="v">${$(c.savable_usd)}</div><div class="s">combined, overlaps counted once</div></div>
  </div>
  <div class="track" role="img" aria-label="estimate range and actual cost">
    ${e ? `<div class="band" style="left:${pct(e.low_usd)};width:calc(${pct(e.high_usd)} - ${pct(e.low_usd)})"></div><div class="tick est" style="left:${pct(e.usd)}" title="estimate ${$(e.usd)}"></div>` : ''}
    <div class="tick act ${st.cls}" style="left:${pct(c.actual_usd)}" title="actual ${$(c.actual_usd)}"></div>
  </div>
  <div class="legend">${e ? '<span><i class="sw band"></i>typical range</span><span><i class="sw est"></i>estimate</span>' : ''}<span><i class="sw act ${st.cls}"></i>actual</span></div>
  ${waste.length ? `<h3>Where it went</h3><div class="drivers">${waste.map(row).join('')}</div>` : ''}
  ${adds.length ? `<h3>Add for next time: skills, subagents, MCP servers, settings</h3><div class="drivers add">${adds.map(row).join('')}</div>` : ''}
  ${c.drivers.length ? '' : '<p class="muted">Nothing in this session stands out as avoidable spend, and no pattern calls for a new skill, MCP server or setting.</p>'}
  ${
    fixes.size
      ? `<h3>Apply for the next similar story</h3><div class="fixes">${[...fixes.values()]
          .map((f) => {
            const cmd = f.apply.kind === 'command' ? f.apply.commands.join(' && ') : f.apply.kind === 'advice' ? '' : `${cli} fix ${f.id}`;
            return `<div class="fix"><div><b>${esc(f.title)}</b><div class="muted">${esc(f.what)}</div></div>${cmd ? `<code class="cmd${cmd.length > 40 ? ' long' : ''}">${esc(cmd)}</code>` : '<span class="muted small">advice only</span>'}</div>`;
          })
          .join('')}</div><p class="muted small">${[...fixes.values()].some((f) => f.apply.kind === 'settings' || f.apply.kind === 'file' || f.apply.kind === 'claude_md') ? `<code>${esc(cli)} fix</code> writes into the repo (.claude/settings.json, .claude/agents, .claude/skills, CLAUDE.md), so a commit gives the team the change; --global writes ~/.claude instead; <code>${esc(cli)} undo</code> reverts. ` : ''}Install commands for MCP servers and plugins are shown, never run.</p>`
      : ''
  }
</section>`;
}

function estimateCard(story: string, e: CostEstimate): string {
  const rows = e.neighbours.map((n) => `<tr><td>${esc(n.text)}</td><td class="num">${n.similarity.toFixed(2)}</td><td class="num">${$(n.cost_usd)}</td><td>${esc(n.models[0] ?? '')}</td></tr>`).join('');
  return `<section class="card hero">
  <div class="eyebrow">Estimate before you start</div>
  <h2>${esc(story.slice(0, 120))}</h2>
  <div class="nums">
    <div><div class="k">Estimate</div><div class="v">${e.basis === 'none' ? '–' : $(e.usd)}</div><div class="s">${e.basis === 'none' ? 'no history yet' : `${$(e.low_usd)}–${$(e.high_usd)} typical`}</div></div>
    <div><div class="k">Based on</div><div class="v">${e.n}</div><div class="s">${e.basis === 'similar' ? 'similar past stories' : e.basis === 'points' ? 'pointed stories ($ per point)' : e.basis === 'repo' ? 'sessions in this repo (nothing similar)' : 'sessions (nothing similar)'}</div></div>
    <div><div class="k">Confidence</div><div class="v small-v">${esc(e.confidence)}</div><div class="s">${e.corpus} stories searched</div></div>
  </div>
  ${rows ? `<h3>The stories behind it</h3><table><thead><tr><th>Story</th><th class="num">Similarity</th><th class="num">Cost</th><th>Model</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
</section>`;
}

function rangeChart(entries: LedgerEntry[]): string {
  const xs = entries.slice(-40);
  if (!xs.length) return '';
  const W = 760;
  const rowH = 22;
  const left = 230;
  const H = xs.length * rowH + 30;
  const max = Math.max(...xs.map((e) => Math.max(e.actual_usd, e.estimate_high_usd ?? 0, e.estimate_usd ?? 0)), 0.01) * 1.08;
  const x = (v: number) => left + (v / max) * (W - left - 60);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const rows = xs
    .map((e, i) => {
      const y = 20 + i * rowH;
      const st = statusOf(e);
      const band = e.estimate_low_usd !== undefined && e.estimate_high_usd !== undefined ? `<rect class="band" x="${x(e.estimate_low_usd).toFixed(1)}" y="${y - 6}" width="${Math.max(2, x(e.estimate_high_usd) - x(e.estimate_low_usd)).toFixed(1)}" height="12" rx="3"><title>typical ${$(e.estimate_low_usd)}–${$(e.estimate_high_usd)}</title></rect>` : '';
      const est = e.estimate_usd !== undefined ? `<line class="est" x1="${x(e.estimate_usd).toFixed(1)}" x2="${x(e.estimate_usd).toFixed(1)}" y1="${y - 8}" y2="${y + 8}"><title>estimate ${$(e.estimate_usd)}</title></line>` : '';
      return `<g><text class="lbl" x="${left - 10}" y="${y + 4}" text-anchor="end">${esc((e.key ? e.key + ' ' : '') + e.story).slice(0, 34)}</text>${band}${est}<circle class="act ${st.cls}" cx="${x(e.actual_usd).toFixed(1)}" cy="${y}" r="5"><title>${esc(e.story)}: ${$(e.actual_usd)}${e.estimate_usd !== undefined ? ` vs ~${$(e.estimate_usd)}` : ''}</title></circle><text class="val" x="${(x(e.actual_usd) + 9).toFixed(1)}" y="${y + 4}">${$(e.actual_usd)}</text></g>`;
    })
    .join('');
  const grid = ticks.map((t) => `<line class="grid" x1="${x(t).toFixed(1)}" x2="${x(t).toFixed(1)}" y1="8" y2="${H - 18}"/><text class="axis" x="${x(t).toFixed(1)}" y="${H - 4}" text-anchor="middle">${$(t)}</text>`).join('');
  return `<section class="card"><h3>Estimate vs actual, per story</h3><p class="muted small">Band: the typical range of similar past stories. Line: the estimate. Dot: what it cost (<span class="over-t">over</span>, <span class="on-t">on target</span>, <span class="under-t">under</span>, <span class="none-t">no estimate</span>).</p><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="estimate versus actual cost per story">${grid}${rows}</svg></section>`;
}

function barsTable(title: string, rows: Array<{ label: string; usd: number; note?: string }>, note?: string): string {
  if (!rows.length) return '';
  const max = Math.max(...rows.map((r) => r.usd), 0.01);
  return `<section class="card"><h3>${esc(title)}</h3>${note ? `<p class="muted small">${note}</p>` : ''}<div class="drivers">${rows
    .map((r) => `<div class="drow"><div class="dname">${esc(r.label)}${r.note ? `<div class="ddet">${esc(r.note)}</div>` : ''}</div><div class="dbar"><div style="width:${((r.usd / max) * 100).toFixed(1)}%"></div></div><div class="dval">${$(r.usd)}</div></div>`)
    .join('')}</div></section>`;
}

export function renderDashboard(opts: { repo: string; entries: LedgerEntry[]; current?: CostCheck; estimate?: { story: string; estimate: CostEstimate }; cli?: string; now?: Date; ledgerPath?: string }): string {
  const cli = opts.cli ?? 'tally';
  const entries = opts.entries;
  const spend = sum(entries.map((e) => e.actual_usd));
  const priced = entries.filter((e) => e.estimate_usd !== undefined && e.estimate_basis !== 'all');
  const err = priced.map((e) => Math.abs(e.actual_usd - e.estimate_usd!) / Math.max(e.actual_usd, 0.01));
  const inRange = priced.filter((e) => e.actual_usd >= (e.estimate_low_usd ?? 0) && e.actual_usd <= (e.estimate_high_usd ?? Infinity)).length;
  const over = priced.filter((e) => e.status === 'over');
  const avoidable = sum(entries.map((e) => e.savable_usd ?? 0));

  const byDriver = new Map<string, { usd: number; stories: number; fix?: string }>();
  const byAdd = new Map<string, { usd: number; stories: number; fix?: string }>();
  for (const e of entries)
    for (const d of e.drivers) {
      if (d.group === 'add') {
        const cur = byAdd.get(d.id) ?? { usd: 0, stories: 0, fix: d.fix };
        cur.usd += d.usd;
        cur.stories += 1;
        byAdd.set(d.id, cur);
        continue;
      }
      const cur = byDriver.get(d.id) ?? { usd: 0, stories: 0, fix: d.fix };
      cur.usd += d.usd;
      cur.stories += 1;
      byDriver.set(d.id, cur);
    }
  const driverRows = [...byDriver.entries()].sort((a, b) => b[1].usd - a[1].usd).map(([id, v]) => ({ label: DRIVER_NAMES[id] ?? id, usd: v.usd, note: `${v.stories} ${v.stories === 1 ? 'story' : 'stories'}${v.fix && v.fix !== 'split-story' ? ` · ${cli} fix ${v.fix}` : ''}` }));
  const group = (key: (e: LedgerEntry) => string | undefined) => {
    const m = new Map<string, { usd: number; n: number; over: number }>();
    for (const e of entries) {
      const k = key(e) ?? 'unknown';
      const cur = m.get(k) ?? { usd: 0, n: 0, over: 0 };
      cur.usd += e.actual_usd;
      cur.n += 1;
      if (e.status === 'over') cur.over += 1;
      m.set(k, cur);
    }
    return [...m.entries()].sort((a, b) => b[1].usd - a[1].usd).map(([label, v]) => ({ label, usd: v.usd, note: `${v.n} ${v.n === 1 ? 'story' : 'stories'}${v.over ? ` · ${v.over} over estimate` : ''}` }));
  };
  const table = entries.length
    ? `<section class="card"><h3>Every story</h3><div class="scroll"><table><thead><tr><th>Date</th><th>Story</th><th>Who</th><th>Model</th><th class="num">Estimate</th><th class="num">Actual</th><th class="num">Difference</th><th class="num">Avoidable</th></tr></thead><tbody>${[...entries]
        .reverse()
        .map((e) => {
          const st = statusOf(e);
          return `<tr><td class="nowrap">${esc(e.ts.slice(0, 10))}</td><td>${e.url ? `<a href="${esc(e.url)}">${esc(e.key ?? '')}</a> ` : e.key ? esc(e.key) + ' ' : ''}${esc(e.story)}</td><td>${esc(e.author ?? '')}</td><td>${esc(e.model)}</td><td class="num">${$(e.estimate_usd)}</td><td class="num">${$(e.actual_usd)}</td><td class="num ${st.cls}">${e.delta_usd === undefined ? '–' : `${e.delta_usd >= 0 ? '+' : '−'}${$(Math.abs(e.delta_usd))}`}</td><td class="num">${$(e.savable_usd)}</td></tr>`;
        })
        .join('')}</tbody></table></div></section>`
    : `<section class="card"><h3>No team history yet</h3><p class="muted">Finished stories are recorded in <code>.tally/ledger.jsonl</code> in this repo. Commit it and everyone who works here shares the estimates and this page.</p></section>`;

  const generated = (opts.now ?? new Date()).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tally · ${esc(opts.repo)}</title>
<style>
:root{--bg:#f6f5f1;--card:#fff;--ink:#1d2329;--mute:#68717b;--line:#e4e1d9;--accent:#2f6fde;--over:#c8432f;--under:#2e8b57;--on:#3d7a9e;--none:#9aa1a8;--band:#d9e4f6}
@media (prefers-color-scheme:dark){:root{--bg:#14171b;--card:#1c2026;--ink:#e8e6e1;--mute:#98a0a8;--line:#2c323a;--accent:#7aa7ff;--over:#ff7a66;--under:#5fcf8f;--on:#79b8dc;--none:#6c737a;--band:#2a3a55}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif}
.wrap{max-width:1040px;margin:0 auto;padding:28px 16px 60px}
header{display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap;margin-bottom:18px}
header h1{font-size:22px;margin:0}header .muted{font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px 22px;margin:14px 0}
.hero h2{margin:4px 0 14px;font-size:20px}.eyebrow{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--mute)}
h3{font-size:15px;margin:18px 0 10px}.card>h3:first-child{margin-top:0}
.nums{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px}
.k{font-size:12px;color:var(--mute)}.v{font-size:28px;font-weight:650;font-variant-numeric:tabular-nums}.small-v{font-size:22px}.s{font-size:12px;color:var(--mute)}
.v.over,.num.over,.over-t{color:var(--over)}.v.under,.num.under,.under-t{color:var(--under)}.v.on,.num.on,.on-t{color:var(--on)}.none-t{color:var(--none)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.kpis .card{margin:0;padding:14px 16px}
.track{position:relative;height:28px;margin:22px 0 6px;border-bottom:1px solid var(--line)}
.track .band{position:absolute;top:6px;height:16px;background:var(--band);border-radius:4px}
.track .tick{position:absolute;top:0;width:3px;height:28px;margin-left:-1.5px;border-radius:2px}
.tick.est{background:var(--ink)}.tick.act{width:12px;height:12px;top:8px;margin-left:-6px;border-radius:50%}
.act.over{background:var(--over)}.act.under{background:var(--under)}.act.on{background:var(--on)}.act.none{background:var(--none)}
.legend{display:flex;gap:16px;font-size:12px;color:var(--mute)}.sw{display:inline-block;width:12px;height:10px;margin-right:6px;border-radius:2px;vertical-align:middle}
.sw.band{background:var(--band)}.sw.est{background:var(--ink);width:3px}.sw.act{border-radius:50%;width:10px}
.drivers{display:grid;gap:10px}.drow{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(80px,1fr) 80px;gap:14px;align-items:center}
.dname{font-weight:550}.ddet{font-weight:400;font-size:12.5px;color:var(--mute)}
.dbar{height:10px;background:var(--line);border-radius:5px;overflow:hidden}.dbar>div{height:100%;background:var(--accent);border-radius:5px}.add .dbar>div{background:var(--under)}
.dval,.num{text-align:right;font-variant-numeric:tabular-nums}
.fixes{display:grid;gap:10px}.fix{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 16px;align-items:center;border:1px solid var(--line);border-radius:8px;padding:10px 12px}.fix>div{min-width:0}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}.cmd{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:4px 8px;user-select:all;overflow-wrap:anywhere;max-width:100%}.cmd.long{grid-column:1/-1}
.muted{color:var(--mute)}.small{font-size:12.5px}
table{width:100%;border-collapse:collapse;font-size:13.5px}th,td{padding:7px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-weight:600;color:var(--mute);font-size:12px}
.scroll{overflow-x:auto}.nowrap{white-space:nowrap}a{color:var(--accent)}
svg text{fill:var(--mute);font-size:11px}svg .lbl{fill:var(--ink);font-size:11.5px}svg .val{fill:var(--ink);font-size:11px}
svg .grid{stroke:var(--line)}svg .band{fill:var(--band)}svg .est{stroke:var(--ink);stroke-width:2}
svg .act.over{fill:var(--over)}svg .act.under{fill:var(--under)}svg .act.on{fill:var(--on)}svg .act.none{fill:var(--none)}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}.two .card{margin:0}
@media (max-width:600px){.drow{grid-template-columns:1fr 70px}.drow .dbar{grid-column:1/3;grid-row:2}}
</style></head><body><div class="wrap">
<header><h1>Tally · ${esc(opts.repo)}</h1><div class="muted">Generated ${esc(generated)}${opts.ledgerPath ? ` from ${esc(opts.ledgerPath)}` : ''} · local file, nothing was sent anywhere</div></header>
${opts.estimate ? estimateCard(opts.estimate.story, opts.estimate.estimate) : ''}
${opts.current ? currentCard(opts.current, cli) : ''}
${entries.length ? `<div class="kpis">
  <div class="card"><div class="k">Stories</div><div class="v">${entries.length}</div><div class="s">in the team ledger</div></div>
  <div class="card"><div class="k">Spend</div><div class="v">${$(spend)}</div><div class="s">median ${$(entries.length ? quantile(entries.map((e) => e.actual_usd), 0.5) : 0)} per story</div></div>
  <div class="card"><div class="k">Estimate error</div><div class="v">${priced.length ? `${Math.round(quantile(err, 0.5) * 100)}%` : '–'}</div><div class="s">${priced.length ? `median · ${Math.round((inRange / priced.length) * 100)}% inside the range` : 'needs priced stories'}</div></div>
  <div class="card"><div class="k">Over estimate</div><div class="v ${over.length ? 'over' : ''}">${over.length}</div><div class="s">of ${priced.length} priced ${priced.length === 1 ? 'story' : 'stories'}</div></div>
  <div class="card"><div class="k">Avoidable found</div><div class="v">${$(avoidable)}</div><div class="s">sum of per-story savings</div></div>
</div>` : ''}
${rangeChart(entries)}
${barsTable('Where the team’s money goes', driverRows, 'Each driver summed over every story it appeared in, with the fix that addresses it.')}
${barsTable('What to add across the team', [...byAdd.entries()].sort((a, b) => b[1].usd - a[1].usd).map(([id, v]) => ({ label: DRIVER_NAMES[id] ?? id, usd: v.usd, note: `suggested in ${v.stories} ${v.stories === 1 ? 'story' : 'stories'}${v.fix ? ` · ${cli} fix ${v.fix}` : ''}` })), 'Skills, subagents, MCP servers and settings the cost check suggested, with the estimated saving summed over the stories that showed the pattern.')}
<div class="two">${barsTable('By person', group((e) => e.author))}${barsTable('By model', group((e) => e.model))}</div>
${table}
</div></body></html>
`;
}
