/* The cost check: what the story was expected to cost, what it did cost, where the difference went, and the one-line
   change that would make the next similar story cheaper. Every driver is a dollar figure computed from the session's
   own transcript; every fix is a concrete edit to a Claude Code settings file or CLAUDE.md that `tally fix <id>`
   applies (and `tally undo` reverts), or a command printed for the user to run. */
import fs from 'node:fs';
import path from 'node:path';
import { claudeHome, readJson, sessionDir, writeJson } from '../paths.js';
import { canonicalModel, costOf, loadPricing, priceFor, type Pricing } from '../cost/pricing.js';
import { computeWaste } from '../cost/waste.js';
import { isLintCommand, isTestCommand, parseTranscriptFile, type Transcript } from '../transcript/parse.js';
import { readEvents } from '../store/events.js';
import { transcriptPathFor, sessionCwd } from '../session.js';
import { loadTask } from '../task/intake.js';
import { estimateCost, estimateFile, loadEstimate, storyText, type CostEstimate } from './estimate.js';
import { recordChange } from '../coach/undo.js';
import { mergePatch } from '../coach/actions.js';

export type FixApply =
  | { kind: 'settings'; patch: Record<string, unknown>; scope: 'project' | 'local' | 'user' }
  | { kind: 'claude_md'; content: string }
  | { kind: 'command'; commands: string[] }
  | { kind: 'advice' };

export interface Fix {
  id: string;
  title: string;
  /* what the change does, in one line, so nobody applies it blind */
  what: string;
  apply: FixApply;
}

export interface Driver {
  id: string;
  title: string;
  usd: number;
  detail: string;
  basis: 'measured' | 'estimated';
  fix?: Fix;
}

export interface CostCheck {
  session: string;
  cwd?: string;
  task?: string;
  actual_usd: number;
  estimate?: CostEstimate;
  delta_usd?: number;
  delta_pct?: number;
  status: 'over' | 'under' | 'on_target' | 'no_estimate';
  model: string;
  drivers: Driver[];
  savable_usd: number;
  computed_at: string;
}

const CHEAP_MODEL = 'sonnet';
const round2 = (n: number) => Math.round(n * 100) / 100;
const $ = (n: number) => `$${n.toFixed(2)}`;

export function checkFile(session: string): string {
  return path.join(sessionDir(session), 'cost-check.json');
}

export function loadCheck(session: string): CostCheck | null {
  return readJson<CostCheck | null>(checkFile(session), null);
}

/* the session's main-loop model, by spend */
function mainModel(t: Transcript): string {
  const byModel = new Map<string, number>();
  for (const m of t.messages) if (m.agent === 'main' && !m.model.startsWith('<')) byModel.set(m.model, (byModel.get(m.model) ?? 0) + m.cost);
  return [...byModel.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? t.models[0] ?? 'unknown';
}

function repriced(t: Transcript, agent: (a: string) => boolean, pricing: Pricing): { actual: number; cheap: number } {
  const cheapPrice = priceFor(CHEAP_MODEL, pricing);
  let actual = 0;
  let cheap = 0;
  for (const m of t.messages) {
    if (!agent(m.agent) || m.model.startsWith('<')) continue;
    actual += m.cost;
    /* only an expensive model is repriced; a message already on a cheaper model stays as it was */
    cheap += priceFor(m.model, pricing).output > cheapPrice.output ? costOf(m.usage, CHEAP_MODEL, pricing) : m.cost;
  }
  return { actual, cheap };
}

function successfulCommands(t: Transcript): string[] {
  const out: string[] = [];
  for (const c of t.toolCalls) {
    if (c.name !== 'Bash' || c.result?.isError) continue;
    const cmd = typeof c.input.command === 'string' ? c.input.command.trim() : '';
    if (!cmd || cmd.length > 120 || cmd.includes('\n')) continue;
    if ((isTestCommand(cmd) || isLintCommand(cmd) || /\b(npm|pnpm|yarn|bun)\s+run\s+build\b|\bmake\b|\bcargo build\b|\bgo build\b/.test(cmd)) && !out.includes(cmd)) out.push(cmd);
  }
  return out.slice(0, 6);
}

function rel(cwd: string | undefined, f: string): string {
  if (!cwd) return f;
  const r = path.relative(cwd, f);
  return r && !r.startsWith('..') ? r.replace(/\\/g, '/') : f;
}

export function computeCheck(session: string, opts: { transcript?: Transcript; transcriptPath?: string; estimate?: CostEstimate | null; baselineTokens?: number; now?: Date; pricing?: Pricing } = {}): CostCheck {
  const pricing = opts.pricing ?? loadPricing();
  const tPath = opts.transcript ? undefined : opts.transcriptPath ?? transcriptPathFor(session);
  const t = opts.transcript ?? (tPath ? parseTranscriptFile(tPath, pricing) : undefined);
  if (!t) throw new Error(`no transcript found for session ${session}`);
  const cwd = sessionCwd(session) ?? t.cwd;
  const task = loadTask(session);
  let estimate = opts.estimate === undefined ? loadEstimate(session) : opts.estimate;
  if (estimate === null && opts.estimate === undefined) {
    const text = task ? `${task.title}\n${task.body_excerpt}` : storyText(t.prompts.map((p) => p.text), cwd);
    if (text.trim()) {
      estimate = estimateCost(text, { cwd, exclude: session, storyPoints: task?.estimate.story_points });
      writeJson(estimateFile(session), estimate);
    }
  }
  const actual = t.cost;
  const model = mainModel(t);
  const drivers: Driver[] = [];

  /* 1. the main loop's model: the same tokens at Sonnet prices */
  const main = repriced(t, (a) => a === 'main', pricing);
  const modelSave = main.actual - main.cheap;
  if (modelSave >= 0.01 && canonicalModel(model, pricing) !== canonicalModel(CHEAP_MODEL, pricing)) {
    drivers.push({
      id: 'model',
      title: `Main model ${model}`,
      usd: round2(modelSave),
      detail: `the main loop cost ${$(main.actual)}; the same tokens at Sonnet prices cost ${$(main.cheap)}. Sonnet may need more turns, so treat this as the most it could save.`,
      basis: 'estimated',
      fix: { id: 'model-sonnet', title: 'Default this repo to Sonnet', what: 'sets "model": "sonnet" in .claude/settings.json; use /model opus for a story that needs it', apply: { kind: 'settings', patch: { model: 'sonnet' }, scope: 'project' } },
    });
  }

  /* 2. subagents on an expensive model */
  const sub = repriced(t, (a) => a !== 'main', pricing);
  const subSave = sub.actual - sub.cheap;
  if (subSave >= 0.01) {
    drivers.push({
      id: 'subagents',
      title: 'Subagents on an expensive model',
      usd: round2(subSave),
      detail: `subagents cost ${$(sub.actual)} (${Math.round((sub.actual / (actual || 1)) * 100)}% of the session); at Sonnet prices ${$(sub.cheap)}.`,
      basis: 'estimated',
      fix: { id: 'subagent-sonnet', title: 'Run subagents on Sonnet', what: 'sets env CLAUDE_CODE_SUBAGENT_MODEL=sonnet in .claude/settings.json, so subagents without their own model stop inheriting the main one (Explore keeps its own default)', apply: { kind: 'settings', patch: { env: { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' } }, scope: 'project' } },
    });
  }

  const waste = computeWaste(t, { baselineTokens: opts.baselineTokens ?? 15000, pricing });
  const cmds = successfulCommands(t);
  const reread = waste.repeated_reads.slice(0, 5);
  const mdLines: string[] = [];
  if (cmds.length) mdLines.push('## Commands (recorded by Tally from a session where they worked)', ...cmds.map((c) => `- \`${c}\``), '');
  if (reread.length) mdLines.push('## Files agents keep re-reading (recorded by Tally)', ...reread.map((r) => `- ${rel(cwd, r.file)}`), '');
  const claudeMdFix: Fix | undefined = mdLines.length ? { id: 'claude-md', title: 'Write what this session learned into CLAUDE.md', what: `appends ${[cmds.length ? `${cmds.length} working command(s)` : '', reread.length ? `${reread.length} file(s) it kept re-reading` : ''].filter(Boolean).join(' and ')} to CLAUDE.md, so the next session does not rediscover them`, apply: { kind: 'claude_md', content: mdLines.join('\n') } } : undefined;

  /* 3. failed commands retried unchanged */
  const loopUsd = waste.failed_loops.reduce((s, l) => s + l.usd, 0);
  if (loopUsd >= 0.01) drivers.push({ id: 'retries', title: 'Failing commands retried', usd: round2(loopUsd), detail: waste.failed_loops.slice(0, 3).map((l) => `\`${l.command.slice(0, 60)}\` failed ×${l.repeats}`).join('; '), basis: 'measured', fix: claudeMdFix });

  /* 4. the same files read again and again */
  const readUsd = waste.repeated_reads.reduce((s, r) => s + r.usd, 0);
  if (readUsd >= 0.01) drivers.push({ id: 'rereads', title: 'Files re-read', usd: round2(readUsd), detail: reread.slice(0, 3).map((r) => `${rel(cwd, r.file)} ×${r.reads}`).join('; '), basis: 'measured', fix: claudeMdFix });

  /* 5. context loaded before any work: MCP servers and plugins this story never used */
  const start = readEvents(session).find((e) => e.type === 'session_start');
  const loaded = (start?.data.loaded as { mcp?: string[]; skills?: string[]; plugins?: string[] } | undefined) ?? {};
  const usedMcp = new Set(t.mcpCalls.map((c) => c.server));
  const unusedMcp = (loaded.mcp ?? []).filter((m) => !usedMcp.has(m) && m !== 'tally');
  const usedSkills = new Set(t.skills.map((s) => s.name));
  const unusedPlugins = (loaded.plugins ?? []).filter((p) => p !== 'tally' && ![...usedSkills].some((s) => s.startsWith(p + ':')) && ![...usedMcp].some((s) => s.includes(p)));
  const items = (loaded.mcp?.length ?? 0) + (loaded.plugins?.length ?? 0) + (loaded.skills?.length ?? 0);
  const unused = unusedMcp.length + unusedPlugins.length;
  if (waste.dead_weight.usd >= 0.01 && unused > 0 && items > 0) {
    const projectMcp = readJson<{ mcpServers?: Record<string, unknown> }>(path.join(cwd ?? '.', '.mcp.json'), {}).mcpServers ?? {};
    const inProject = unusedMcp.filter((m) => m in projectMcp);
    const elsewhere = unusedMcp.filter((m) => !(m in projectMcp));
    const commands = [...elsewhere.map((m) => `claude mcp remove ${m} --scope user`), ...unusedPlugins.map((p) => `claude plugin disable ${p}`)];
    const fix: Fix = inProject.length
      ? { id: 'drop-unused-mcp', title: 'Stop loading MCP servers this repo does not use', what: `adds ${inProject.join(', ')} to disabledMcpjsonServers in .claude/settings.local.json${commands.length ? `; also run: ${commands.join(' && ')}` : ''}`, apply: { kind: 'settings', patch: { disabledMcpjsonServers: inProject }, scope: 'local' } }
      : { id: 'drop-unused-mcp', title: 'Stop loading MCP servers and plugins this story did not use', what: 'prints the commands; Tally does not remove servers or plugins itself', apply: { kind: 'command', commands } };
    drivers.push({
      id: 'context',
      title: 'Tools loaded but never used',
      usd: round2((waste.dead_weight.usd * unused) / items),
      detail: `${waste.dead_weight.overhead_tokens.toLocaleString('en-US')} tokens were in context before the first prompt and re-sent on every call; unused here: ${[...unusedMcp.map((m) => `MCP ${m}`), ...unusedPlugins.map((p) => `plugin ${p}`)].slice(0, 6).join(', ')}. Share of that overhead, spread evenly over ${items} loaded item(s).`,
      basis: 'estimated',
      fix,
    });
  }

  /* 6. a long-running context: every call re-sends everything before it, so the tokens above ~80k are paid again on
     each turn. Measured from the main loop's own usage. */
  const LONG = 80000;
  const cacheRead = priceFor(model, pricing).cache_read;
  let longUsd = 0;
  let longCalls = 0;
  for (const m of t.messages) {
    if (m.agent !== 'main') continue;
    const ctx = m.usage.input + m.usage.cache_read + m.usage.cache_write;
    if (ctx > LONG) {
      longUsd += ((ctx - LONG) * cacheRead) / 1e6;
      longCalls += 1;
    }
  }
  if (longUsd >= 0.05) {
    drivers.push({
      id: 'long-context',
      title: 'One long conversation',
      usd: round2(longUsd),
      detail: `${longCalls} call(s) carried more than ${LONG / 1000}k tokens of history; re-sending the part above ${LONG / 1000}k cost ${$(longUsd)}. Part of this is the work itself; a fresh session per sub-task avoids most of it.`,
      basis: 'measured',
      fix: { id: 'split-story', title: 'Split stories this size', what: 'run /clear (or a new session) between sub-tasks, with the plan in a file so nothing is lost; Tally cannot apply this for you', apply: { kind: 'advice' } },
    });
  }

  /* 7. the context grew until it had to be compacted */
  if (waste.compaction_churn.usd >= 0.01) {
    drivers.push({
      id: 'compaction',
      title: 'Context compacted and re-cached',
      usd: round2(waste.compaction_churn.usd),
      detail: `${waste.compaction_churn.compactions} compaction(s) re-cached ${waste.compaction_churn.recache_tokens.toLocaleString('en-US')} tokens. A story this size is cheaper as two sessions.`,
      basis: 'measured',
      fix: { id: 'split-story', title: 'Split stories this size', what: 'run /clear (or a new session) between sub-tasks; Tally cannot apply this for you', apply: { kind: 'advice' } },
    });
  }

  /* an estimated driver can never be more than the session itself cost */
  for (const d of drivers) d.usd = round2(Math.min(d.usd, actual));
  drivers.sort((a, b) => b.usd - a.usd);
  /* the combined saving, counted once: one fix can answer two drivers (CLAUDE.md covers retries and re-reads), and
     once the model is cheaper every other main-loop driver costs proportionally less */
  const seen = new Set<string>();
  const cheapRatio = drivers.some((d) => d.id === 'model') && main.actual > 0 ? main.cheap / main.actual : 1;
  let savable = 0;
  for (const d of drivers) {
    if (d.fix && seen.has(d.fix.id)) continue;
    if (d.fix) seen.add(d.fix.id);
    savable += d.id === 'model' || d.id === 'subagents' ? d.usd : d.usd * cheapRatio;
  }
  savable = Math.min(savable, actual);
  /* only a comparable story (or this repo's own sessions) makes an over/under call; the median of every unrelated
     session is shown for scale but judges nothing */
  const est = estimate && (estimate.basis === 'similar' || estimate.basis === 'points' || estimate.basis === 'repo') ? estimate : undefined;
  const delta = est ? actual - est.usd : undefined;
  const status: CostCheck['status'] = !est ? 'no_estimate' : actual > est.high_usd || (delta! > 0 && actual > est.usd * 1.2) ? 'over' : actual < est.usd * 0.8 ? 'under' : 'on_target';
  const check: CostCheck = {
    session,
    cwd,
    task: task?.title ?? t.prompts[0]?.text.slice(0, 80),
    actual_usd: round2(actual),
    ...(est ? { estimate: est, delta_usd: round2(delta!), delta_pct: est.usd > 0 ? Math.round((delta! / est.usd) * 100) : 0 } : estimate ? { estimate } : {}),
    status,
    model,
    drivers,
    savable_usd: round2(savable),
    computed_at: (opts.now ?? new Date()).toISOString(),
  };
  writeJson(checkFile(session), check);
  return check;
}

export function renderCheck(c: CostCheck, opts: { cli?: string } = {}): string {
  const cli = opts.cli ?? 'tally';
  const L: string[] = [];
  L.push('Tally cost check');
  L.push('');
  if (c.task) L.push(`Story:     ${c.task.split('\n')[0]!.slice(0, 90)}`);
  if (c.estimate && c.estimate.basis !== 'none') {
    const e = c.estimate;
    if (e.basis === 'all') L.push(`Estimate:  none (no similar past story yet; your median session costs ${$(e.usd)})`);
    else L.push(`Estimate:  ${$(e.usd)}  (typical ${$(e.low_usd)}–${$(e.high_usd)}, ${e.basis === 'similar' ? `${e.n} similar past ${e.n === 1 ? 'story' : 'stories'}` : e.basis === 'points' ? `story points × cost per point of ${e.n} pointed stories` : `median of ${e.n} past sessions in this repo, nothing similar enough`}, ${e.confidence} confidence)`);
  } else L.push('Estimate:  none yet (no past sessions on this machine to compare with)');
  L.push(`Actual:    ${$(c.actual_usd)}  on ${c.model}`);
  if (c.delta_usd !== undefined) {
    const d = c.delta_usd;
    const verdict = c.status === 'over' ? `OVER by ${$(d)} (+${c.delta_pct}%)` : c.status === 'under' ? `UNDER by ${$(-d)} (${c.delta_pct}%)` : `ON TARGET (${d >= 0 ? '+' : '−'}${$(Math.abs(d))})`;
    L.push(`Result:    ${verdict}`);
  }
  L.push('');
  if (!c.drivers.length) {
    L.push('Nothing in this session stands out as avoidable spend.');
    return L.join('\n');
  }
  L.push(c.status === 'over' ? `Where it went (up to ${$(c.savable_usd)} avoidable, combined, against the ${$(c.delta_usd ?? 0)} overage; the lines overlap):` : `Where it could be cheaper next time (up to ${$(c.savable_usd)} combined; the lines overlap, so they do not add up):`);
  for (const d of c.drivers) L.push(`  ${$(d.usd).padStart(8)}  ${d.title}${d.basis === 'estimated' ? ' (estimate)' : ''}\n            ${d.detail}`);
  const fixes = new Map<string, Fix>();
  for (const d of c.drivers) if (d.fix && !fixes.has(d.fix.id)) fixes.set(d.fix.id, d.fix);
  L.push('');
  L.push('Apply for the next similar story (one line each; undo with `tally undo`):');
  for (const f of fixes.values()) {
    if (f.apply.kind === 'advice') L.push(`  ·  ${f.title}: ${f.what}`);
    else if (f.apply.kind === 'command') L.push(`  ·  ${f.title}: ${f.apply.commands.join(' && ')}`);
    else L.push(`  ${`${cli} fix ${f.id}`.padEnd(28)} ${f.title} (${f.what})`);
  }
  return L.join('\n');
}

/* one line for the user at the end of a turn */
export function headline(c: CostCheck): string {
  const top = c.drivers.find((d) => d.fix && d.fix.apply.kind !== 'advice');
  const lever = top ? ` Biggest lever: ${top.title.toLowerCase()} (~${$(top.usd)}) → \`tally fix ${top.fix!.id}\`.` : '';
  if (c.status === 'over') return `Tally: this story has cost ${$(c.actual_usd)} against a ~${$(c.estimate!.usd)} estimate from similar stories (+${$(c.delta_usd!)}).${lever} Full breakdown: /tally:cost`;
  if (c.status === 'under') return `Tally: ${$(c.actual_usd)} so far, under the ~${$(c.estimate!.usd)} estimate for similar stories.`;
  if (c.status === 'on_target') return `Tally: ${$(c.actual_usd)} so far, on target for the ~${$(c.estimate!.usd)} estimate.`;
  return `Tally: ${$(c.actual_usd)} so far.${lever}`;
}

function settingsFileFor(scope: 'project' | 'local' | 'user', cwd: string): string {
  if (scope === 'user') return path.join(claudeHome(), 'settings.json');
  return path.join(cwd, '.claude', scope === 'local' ? 'settings.local.json' : 'settings.json');
}

export function findFix(c: CostCheck, id: string): Fix | undefined {
  for (const d of c.drivers) if (d.fix?.id === id) return d.fix;
  return undefined;
}

export function applyFix(fix: Fix, opts: { session: string; cwd: string; global?: boolean }): { ok: boolean; detail: string; file?: string } {
  const a = fix.apply;
  if (a.kind === 'advice') return { ok: false, detail: `${fix.title}: ${fix.what}` };
  if (a.kind === 'command') return { ok: false, detail: `Tally does not run these for you:\n  ${a.commands.join('\n  ')}` };
  if (a.kind === 'claude_md') {
    const file = path.join(opts.cwd, 'CLAUDE.md');
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    /* each section keeps only the lines CLAUDE.md does not already have; a section left with none is dropped */
    const sections = a.content
      .split(/\n\s*\n/)
      .map((sec) => {
        const [heading, ...bullets] = sec.trim().split('\n');
        const fresh = bullets.filter((b) => !(before ?? '').includes(b));
        return fresh.length ? [heading, ...fresh].join('\n') : '';
      })
      .filter(Boolean);
    if (!sections.length) return { ok: true, detail: 'CLAUDE.md already has all of it', file };
    const after = (before ?? '') + (before && !before.endsWith('\n') ? '\n' : '') + (before ? '\n' : '') + sections.join('\n\n') + '\n';
    fs.writeFileSync(file, after);
    recordChange({ session: opts.session, rule: `fix:${fix.id}`, label: fix.title, file, before, after });
    return { ok: true, detail: `appended to ${file}`, file };
  }
  const scope = opts.global ? 'user' : a.scope;
  const file = settingsFileFor(scope, opts.cwd);
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  let current: Record<string, unknown> = {};
  if (before?.trim()) {
    try {
      current = JSON.parse(before) as Record<string, unknown>;
    } catch {
      return { ok: false, detail: `${file} is not valid JSON; not touching it` };
    }
  }
  const after = JSON.stringify(mergePatch(current, a.patch), null, 2) + '\n';
  /* a shell ANTHROPIC_MODEL beats the settings file's "model", so the fix would silently do nothing */
  const shadow = 'model' in a.patch && process.env.ANTHROPIC_MODEL ? `\nNote: ANTHROPIC_MODEL=${process.env.ANTHROPIC_MODEL} is set in your shell and overrides this setting; unset it for the change to apply.` : '';
  if (after === before) return { ok: true, detail: `${file} already has it${shadow}`, file };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, after);
  recordChange({ session: opts.session, rule: `fix:${fix.id}`, label: fix.title, file, before, after });
  return { ok: true, detail: `updated ${file}${scope === 'project' ? ' (commit it and the whole team gets it)' : ''}${shadow}`, file };
}
