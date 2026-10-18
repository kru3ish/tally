/* The cost page: one self-contained HTML file (inline CSS, a few lines of inline script for the copy buttons, no
   network) written to the temp directory and opened in the browser. It reads top to bottom as an answer:
     1. what the story cost against what it should have
     2. the few changes worth making next time, each with one command and a Copy button
     3. the details, folded away: where the money went, other tools that do the same job, the team's history. */
import type { LedgerEntry } from './ledger.js';
import type { CostCheck } from './variance.js';
import type { CostEstimate } from './estimate.js';
import { quantile } from './estimate.js';
import { buildActions, type Action } from './actions.js';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const $ = (n: number | undefined) => (n === undefined ? '–' : n >= 100 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

const KIND_LABEL: Record<Action['kind'], string> = { setting: 'Setting', plugin: 'Plugin', skill: 'Skill', subagent: 'Subagent', notes: 'CLAUDE.md', command: 'Command', habit: 'Habit' };

function copyBox(cmd: string): string {
  return `<div class="cmdrow"><code>${esc(cmd)}</code><button type="button" data-copy="${esc(cmd)}">Copy</button></div>`;
}

function status(c: { status: string; delta_usd?: number; delta_pct?: number }): { cls: string; text: string } {
  if (c.status === 'over') return { cls: 'over', text: `${$(c.delta_usd)} over` };
  if (c.status === 'under') return { cls: 'under', text: `${$(Math.abs(c.delta_usd ?? 0))} under` };
  if (c.status === 'on_target') return { cls: 'on', text: 'On target' };
  return { cls: 'none', text: 'No estimate yet' };
}

function actionCard(a: Action, i: number, cli: string): string {
  const others = a.others.length
    ? `<details class="others"><summary>${a.others.length} other ${a.others.length === 1 ? 'tool does' : 'tools do'} this</summary>${a.others
        .map(
          (o) =>
            `<div class="other"><div><span class="tag ${o.tier}">${o.tier === 'official' ? 'Official' : 'Community'}${o.stars !== undefined ? ` · ★${o.stars >= 1000 ? (o.stars / 1000).toFixed(1) + 'k' : o.stars}` : ''}</span> ${o.url ? `<a href="${esc(o.url)}">${esc(o.name)}</a>` : `<b>${esc(o.name)}</b>`}<div class="sub">${esc(o.description.slice(0, 150))}</div></div>${o.install ? copyBox(o.install) : ''}</div>`,
        )
        .join('')}</details>`
    : '';
  return `<li class="action">
  <div class="num">${i + 1}</div>
  <div class="body">
    <div class="atop"><h3>${esc(a.title)}</h3>${a.usd >= 0.01 ? `<span class="save">up to ${$(a.usd)}</span>` : ''}</div>
    <div class="meta"><span class="tag">${KIND_LABEL[a.kind]}</span>${a.source === 'official' ? '<span class="tag official">Official plugin</span>' : a.source === 'tally' && a.kind !== 'habit' && a.tallyFix ? '<span class="tag">By Tally · undoable</span>' : ''}</div>
    <p>${esc(a.why)}</p>
    ${a.command ? copyBox(a.command) : '<p class="sub">Nothing to install; this one is how the work is split.</p>'}
    ${others}
  </div>
</li>`;
}

function storySection(c: CostCheck, cli: string): string {
  const e = c.estimate && !['none', 'all'].includes(c.estimate.basis) ? c.estimate : undefined;
  const st = status(c);
  const actions = buildActions(c, cli);
  const top = actions.filter((a) => a.kind !== 'habit').slice(0, 5);
  const rest = actions.filter((a) => !top.includes(a));
  const appliable = actions.filter((a) => a.tallyFix && a.source === 'tally').length;
  const max = Math.max(c.actual_usd, e?.high_usd ?? 0) * 1.08 || 1;
  const pct = (n: number) => `${Math.min(100, (n / max) * 100).toFixed(1)}%`;
  const summary = c.savable_usd >= 0.01 ? `About <b>${$(c.savable_usd)}</b> of this could be avoided next time${top.length ? `. ${top.length === 1 ? 'The change below gets' : `The ${top.length} changes below get`} most of it.` : '.'}` : 'Nothing in this story stands out as avoidable spend.';
  return `<section class="hero">
  <div class="eyebrow">This story</div>
  <h1>${esc(c.task?.split('\n')[0]?.slice(0, 110) ?? 'Untitled story')}</h1>
  <div class="figures">
    <div><div class="k">Cost</div><div class="v">${$(c.actual_usd)}</div><div class="sub">${esc(c.model)}</div></div>
    <div><div class="k">Estimate</div><div class="v">${e ? `~${$(e.usd)}` : '–'}</div><div class="sub">${e ? `${$(e.low_usd)}–${$(e.high_usd)} · ${e.basis === 'similar' ? `${e.n} similar ${e.n === 1 ? 'story' : 'stories'}` : e.basis === 'points' ? 'story points' : 'this repo'}` : 'nothing similar done before'}</div></div>
    <div><div class="k">Result</div><div class="v"><span class="pill ${st.cls}">${st.text}</span></div><div class="sub">${c.delta_pct !== undefined && e ? `${c.delta_pct >= 0 ? '+' : ''}${c.delta_pct}% vs estimate` : ''}</div></div>
  </div>
  ${e ? `<div class="track" aria-hidden="true"><div class="band" style="left:${pct(e.low_usd)};width:calc(${pct(e.high_usd)} - ${pct(e.low_usd)})"></div><div class="est" style="left:${pct(e.usd)}"></div><div class="dot ${st.cls}" style="left:${pct(c.actual_usd)}"></div></div><div class="legend"><span><i class="sw band"></i>usual range</span><span><i class="sw est"></i>estimate</span><span><i class="sw dot ${st.cls}"></i>this story</span></div>` : ''}
  <p class="lead">${summary}</p>
</section>
${
  top.length
    ? `<section>
  <div class="shead"><h2>Next time</h2>${appliable > 1 ? `<div class="all"><span class="sub">Apply all ${appliable} of Tally's changes</span>${copyBox(`${cli} fix all`)}</div>` : ''}</div>
  <ol class="actions">${top.map((a, i) => actionCard(a, i, cli)).join('')}</ol>
  ${rest.length ? `<details class="more"><summary>${rest.length} more</summary><ol class="actions">${rest.map((a, i) => actionCard(a, top.length + i, cli)).join('')}</ol></details>` : ''}
  <p class="hint">Paste a command in a terminal in this repo, or ask Claude in the session: <code>/tally:fix ${esc(top[0]!.id)}</code>. Changes land in the repo's <code>.claude/</code> folder, so committing them gives the team the same setup.</p>
</section>`
    : ''
}
${
  c.drivers.length
    ? `<details class="fold"><summary>Where the money went</summary><div class="drivers">${c.drivers
        .map((d) => {
          const w = Math.max(...c.drivers.map((x) => x.usd), 0.01);
          return `<div class="drow"><div><b>${esc(d.title)}</b>${d.basis === 'estimated' ? ' <span class="sub">(estimate)</span>' : ''}<div class="sub">${esc(d.detail)}</div></div><div class="bar"><div style="width:${((d.usd / w) * 100).toFixed(1)}%" class="${d.group === 'add' ? 'add' : ''}"></div></div><div class="amt">${$(d.usd)}</div></div>`;
        })
        .join('')}</div><p class="sub">Amounts overlap (a cheaper model also makes a long conversation cheaper), so they do not add up to the total above.</p></details>`
    : ''
}
${
  c.stack_tools?.length
    ? `<details class="fold"><summary>Official plugins for your stack (${c.stack_tools.length})</summary><p class="sub">Built for libraries this repo uses. No saving is claimed.</p>${c.stack_tools.map((a) => `<div class="other"><div><b>${esc(a.name)}</b><div class="sub">${esc(a.description.slice(0, 150))}</div></div>${a.install ? copyBox(a.install) : ''}</div>`).join('')}</details>`
    : ''
}`;
}

function estimateSection(story: string, e: CostEstimate): string {
  return `<section class="hero">
  <div class="eyebrow">Before you start</div>
  <h1>${esc(story.slice(0, 110))}</h1>
  <div class="figures">
    <div><div class="k">Estimate</div><div class="v">${e.basis === 'none' ? '–' : `~${$(e.usd)}`}</div><div class="sub">${e.basis === 'none' ? 'no history yet' : `${$(e.low_usd)}–${$(e.high_usd)} usual range`}</div></div>
    <div><div class="k">Based on</div><div class="v">${e.n}</div><div class="sub">${e.basis === 'similar' ? 'similar past stories' : e.basis === 'points' ? 'pointed stories ($ per point)' : 'past sessions (nothing similar)'}</div></div>
    <div><div class="k">Confidence</div><div class="v small">${esc(e.confidence)}</div><div class="sub">${e.corpus} stories searched</div></div>
  </div>
  ${e.neighbours.length ? `<details class="fold" open><summary>The stories behind it</summary><table><thead><tr><th>Story</th><th class="r">Similarity</th><th class="r">Cost</th></tr></thead><tbody>${e.neighbours.map((n) => `<tr><td>${esc(n.text)}</td><td class="r">${n.similarity.toFixed(2)}</td><td class="r">${$(n.cost_usd)}</td></tr>`).join('')}</tbody></table></details>` : ''}
</section>`;
}

function teamSection(entries: LedgerEntry[], cli: string): string {
  if (!entries.length) return '';
  const spend = sum(entries.map((e) => e.actual_usd));
  const priced = entries.filter((e) => e.estimate_usd !== undefined && e.estimate_basis !== 'all');
  const err = priced.map((e) => Math.abs(e.actual_usd - e.estimate_usd!) / Math.max(e.actual_usd, 0.01));
  const inRange = priced.filter((e) => e.actual_usd >= (e.estimate_low_usd ?? 0) && e.actual_usd <= (e.estimate_high_usd ?? Infinity)).length;
  const over = priced.filter((e) => e.status === 'over').length;
  const xs = entries.slice(-30);
  const W = 720;
  const rowH = 24;
  const left = 220;
  const H = xs.length * rowH + 26;
  const max = Math.max(...xs.map((e) => Math.max(e.actual_usd, e.estimate_high_usd ?? 0)), 0.01) * 1.1;
  const x = (v: number) => left + (v / max) * (W - left - 64);
  const chart = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="estimate versus cost per story">${xs
    .map((e, i) => {
      const y = 16 + i * rowH;
      const st = status(e).cls;
      return `<text class="lbl" x="${left - 12}" y="${y + 4}" text-anchor="end">${esc(((e.key ? e.key + ' ' : '') + e.story).slice(0, 32))}</text>${e.estimate_low_usd !== undefined && e.estimate_high_usd !== undefined ? `<rect class="band" x="${x(e.estimate_low_usd).toFixed(1)}" y="${y - 5}" width="${Math.max(3, x(e.estimate_high_usd) - x(e.estimate_low_usd)).toFixed(1)}" height="10" rx="5"/>` : ''}<circle class="dot ${st}" cx="${x(e.actual_usd).toFixed(1)}" cy="${y}" r="4.5"><title>${esc(e.story)}: ${$(e.actual_usd)}${e.estimate_usd !== undefined ? ` (estimate ${$(e.estimate_usd)})` : ''}</title></circle><text class="val" x="${(x(e.actual_usd) + 9).toFixed(1)}" y="${y + 4}">${$(e.actual_usd)}</text>`;
    })
    .join('')}</svg>`;
  const adds = new Map<string, { usd: number; n: number; fix: string }>();
  for (const e of entries)
    for (const d of e.drivers) {
      if (!d.fix || d.fix === 'split-story') continue;
      const cur = adds.get(d.fix) ?? { usd: 0, n: 0, fix: d.fix };
      cur.usd += d.usd;
      cur.n += 1;
      adds.set(d.fix, cur);
    }
  const topFixes = [...adds.values()].sort((a, b) => b.usd - a.usd).slice(0, 5);
  return `<section>
  <div class="shead"><h2>Team</h2><span class="sub">${entries.length} ${entries.length === 1 ? 'story' : 'stories'} in .tally/ledger.jsonl</span></div>
  <div class="kpis">
    <div><div class="k">Spend</div><div class="v">${$(spend)}</div><div class="sub">median ${$(quantile(entries.map((e) => e.actual_usd), 0.5))} a story</div></div>
    <div><div class="k">Estimate error</div><div class="v">${priced.length ? `${Math.round(quantile(err, 0.5) * 100)}%` : '–'}</div><div class="sub">${priced.length ? `${Math.round((inRange / priced.length) * 100)}% inside the range` : 'needs priced stories'}</div></div>
    <div><div class="k">Over estimate</div><div class="v ${over ? 'overt' : ''}">${over}<span class="of"> / ${priced.length}</span></div><div class="sub">priced stories</div></div>
  </div>
  <div class="card">${chart}<div class="legend"><span><i class="sw band"></i>usual range</span><span><i class="sw dot over"></i>over</span><span><i class="sw dot on"></i>on target</span><span><i class="sw dot under"></i>under</span></div></div>
  ${topFixes.length ? `<details class="fold"><summary>Changes that keep coming up</summary>${topFixes.map((f) => `<div class="other"><div><b>${esc(f.fix)}</b><div class="sub">suggested in ${f.n} ${f.n === 1 ? 'story' : 'stories'}, up to ${$(f.usd)} in all</div></div>${copyBox(`${cli} fix ${f.fix}`)}</div>`).join('')}</details>` : ''}
  <details class="fold"><summary>Every story</summary><div class="scroll"><table><thead><tr><th>Date</th><th>Story</th><th>Who</th><th class="r">Estimate</th><th class="r">Cost</th><th class="r">Diff</th></tr></thead><tbody>${[...entries]
    .reverse()
    .map((e) => {
      const st = status(e);
      return `<tr><td class="nw">${esc(e.ts.slice(0, 10))}</td><td>${e.url ? `<a href="${esc(e.url)}">${esc(e.key ?? '')}</a> ` : e.key ? esc(e.key) + ' ' : ''}${esc(e.story)}</td><td>${esc(e.author ?? '')}</td><td class="r">${$(e.estimate_usd)}</td><td class="r">${$(e.actual_usd)}</td><td class="r ${st.cls}t">${e.delta_usd === undefined ? '–' : `${e.delta_usd >= 0 ? '+' : '−'}${$(Math.abs(e.delta_usd))}`}</td></tr>`;
    })
    .join('')}</tbody></table></div></details>
</section>`;
}

export function renderDashboard(opts: { repo: string; entries: LedgerEntry[]; current?: CostCheck; estimate?: { story: string; estimate: CostEstimate }; cli?: string; now?: Date; ledgerPath?: string }): string {
  const cli = opts.cli ?? 'tally';
  const generated = (opts.now ?? new Date()).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const body = [opts.estimate ? estimateSection(opts.estimate.story, opts.estimate.estimate) : '', opts.current ? storySection(opts.current, cli) : '', teamSection(opts.entries, cli)].join('\n');
  const empty = !opts.estimate && !opts.current && !opts.entries.length ? `<section class="hero"><h1>No stories yet</h1><p class="lead">When a session ends, its story is added to <code>.tally/ledger.jsonl</code> in this repo. Commit that file and everyone here shares the estimates and this page.</p></section>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tally · ${esc(opts.repo)}</title>
<style>
:root{--bg:#fafaf8;--card:#fff;--ink:#16191d;--mute:#6b7280;--line:#e7e5e0;--soft:#f3f2ee;--accent:#2563eb;--over:#dc4a33;--under:#15803d;--on:#2563eb;--none:#9ca3af;--band:#dbe5f7;--save:#ecfdf3;--saveink:#15803d}
@media (prefers-color-scheme:dark){:root{--bg:#0f1114;--card:#171a1f;--ink:#e9e7e2;--mute:#9aa1aa;--line:#262a31;--soft:#1d2127;--accent:#7aa2ff;--over:#ff7a63;--under:#4ade80;--on:#7aa2ff;--none:#6b7280;--band:#25324a;--save:#123122;--saveink:#6ee7a0}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:860px;margin:0 auto;padding:28px 16px 72px}
header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:22px;color:var(--mute);font-size:13px}
header b{color:var(--ink);font-size:15px;letter-spacing:-.01em}
section{margin:0 0 30px}
.eyebrow{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--mute);margin-bottom:6px}
h1{font-size:24px;line-height:1.25;letter-spacing:-.02em;margin:0 0 20px}
h2{font-size:17px;margin:0;letter-spacing:-.01em}
h3{font-size:15.5px;margin:0;letter-spacing:-.01em}
.hero{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px 26px}
.figures,.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:18px}
.k{font-size:12.5px;color:var(--mute)}.v{font-size:30px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.2;margin:2px 0}.v.small{font-size:22px}.of{font-size:16px;color:var(--mute);font-weight:500}
.sub{font-size:12.5px;color:var(--mute);line-height:1.45}
.pill{display:inline-block;font-size:15px;font-weight:600;padding:3px 12px;border-radius:999px;vertical-align:middle;background:var(--soft)}
.pill.over{color:var(--over);background:color-mix(in srgb,var(--over) 12%,transparent)}.pill.under{color:var(--under);background:color-mix(in srgb,var(--under) 12%,transparent)}.pill.on{color:var(--on);background:color-mix(in srgb,var(--on) 12%,transparent)}.pill.none{color:var(--mute)}
.overt,.overt .of{color:var(--over)}.undert{color:var(--under)}.ont{color:var(--on)}
.track{position:relative;height:22px;margin:22px 0 8px;border-bottom:1px solid var(--line)}
.track .band{position:absolute;top:6px;height:10px;background:var(--band);border-radius:5px}
.track .est{position:absolute;top:2px;width:2px;height:18px;margin-left:-1px;background:var(--ink);border-radius:1px}
.track .dot{position:absolute;top:5px;width:12px;height:12px;margin-left:-6px;border-radius:50%;box-shadow:0 0 0 3px var(--card)}
.dot.over{background:var(--over)}.dot.under{background:var(--under)}.dot.on{background:var(--on)}.dot.none{background:var(--none)}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--mute);margin-top:6px}.sw{display:inline-block;width:12px;height:8px;border-radius:4px;margin-right:6px;vertical-align:middle;background:var(--band)}.sw.est{width:2px;height:12px;background:var(--ink)}.sw.dot{width:9px;height:9px;border-radius:50%}
.lead{font-size:16px;margin:18px 0 0}
.shead{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.all{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.actions{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.action{display:grid;grid-template-columns:28px minmax(0,1fr);gap:14px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px}
.num{width:28px;height:28px;border-radius:50%;background:var(--soft);display:grid;place-items:center;font-weight:650;font-size:13.5px;color:var(--mute)}
.atop{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
.save{font-size:13px;font-weight:600;color:var(--saveink);background:var(--save);padding:2px 10px;border-radius:999px;white-space:nowrap}
.meta{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 2px}
.tag{font-size:11.5px;color:var(--mute);border:1px solid var(--line);border-radius:6px;padding:1px 7px;white-space:nowrap}.tag.official{color:var(--saveink);border-color:color-mix(in srgb,var(--saveink) 40%,transparent)}
.action p{margin:8px 0 10px;font-size:14px;color:color-mix(in srgb,var(--ink) 82%,var(--mute))}
.cmdrow{display:flex;align-items:stretch;border:1px solid var(--line);border-radius:9px;overflow:hidden;background:var(--soft);max-width:100%}
.cmdrow code{flex:1;min-width:0;padding:8px 12px;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-x:auto;white-space:nowrap;user-select:all}
.cmdrow button{border:0;border-left:1px solid var(--line);background:var(--card);color:var(--ink);font:600 12.5px ui-sans-serif,-apple-system,sans-serif;padding:0 14px;cursor:pointer}
.cmdrow button:hover{background:var(--soft)}.cmdrow button.done{color:var(--saveink)}
details summary{cursor:pointer;color:var(--mute);font-size:13.5px;list-style:none}details summary::-webkit-details-marker{display:none}details summary::before{content:"›";display:inline-block;margin-right:7px;transition:transform .15s}details[open]>summary::before{transform:rotate(90deg)}
.others{margin-top:10px}.other{display:grid;gap:8px;padding:10px 0;border-top:1px solid var(--line)}.others .other:first-of-type{margin-top:8px}
.more{margin-top:12px}.more .actions{margin-top:12px}
.fold{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 20px;margin-bottom:12px}.fold[open] summary{margin-bottom:10px}
.hint{font-size:13px;color:var(--mute);margin:14px 2px 0}.hint code,.sub code,.lead code{font:12px ui-monospace,Menlo,monospace;background:var(--soft);padding:1px 5px;border-radius:5px}
.drivers{display:grid;gap:14px}.drow{display:grid;grid-template-columns:minmax(0,1fr) 120px 70px;gap:14px;align-items:center}
.bar{height:8px;background:var(--soft);border-radius:4px;overflow:hidden}.bar>div{height:100%;background:var(--accent);border-radius:4px}.bar>div.add{background:var(--under)}
.amt,.r{text-align:right;font-variant-numeric:tabular-nums}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin:14px 0 12px}
.kpis{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px}
svg text{fill:var(--mute);font-size:11.5px}svg .lbl{fill:var(--ink)}svg .val{fill:var(--ink);font-size:11px}svg .band{fill:var(--band)}
svg .dot.over{fill:var(--over)}svg .dot.under{fill:var(--under)}svg .dot.on{fill:var(--on)}svg .dot.none{fill:var(--none)}
table{width:100%;border-collapse:collapse;font-size:13.5px}th,td{padding:8px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-weight:600;color:var(--mute);font-size:12px}.nw{white-space:nowrap}.scroll{overflow-x:auto}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
@media (max-width:560px){.hero{padding:20px}.action{grid-template-columns:1fr;padding:16px}.num{display:none}.drow{grid-template-columns:1fr 64px}.drow .bar{display:none}h1{font-size:21px}}
</style></head><body><div class="wrap">
<header><span><b>Tally</b> · ${esc(opts.repo)}</span><span>${esc(generated)} · a local file; nothing was sent anywhere</span></header>
${body}${empty}
</div>
<script>
document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('button[data-copy]');if(!b)return;var t=b.getAttribute('data-copy');function ok(){b.textContent='Copied';b.classList.add('done');setTimeout(function(){b.textContent='Copy';b.classList.remove('done')},1600)}function fallback(){var a=document.createElement('textarea');a.value=t;document.body.appendChild(a);a.select();try{document.execCommand('copy')}catch(_){}a.remove();ok()}if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(ok,fallback)}else{fallback()}});
</script>
</body></html>
`;
}
