/* `tally replay <session>`: the session as a timeline with the moments that mattered marked: each prompt, the first
   failing test, the point a retry loop started, when context passed 70%, each compaction, ship events, and the
   receipt's verdict. A learning tool for one person and a post-mortem for a team. */
import { type Args, has } from '../cli.js';
import { resolveSession, transcriptPathFor } from '../session.js';
import { parseTranscriptFile, type Transcript } from '../transcript/parse.js';
import { readEvents } from '../store/events.js';
import { loadJudge } from '../judge/judge.js';
import { loadTask } from '../task/intake.js';
import { fmtUsd } from '../cost/pricing.js';
import { loadConfig } from '../config.js';
import { resolveSessionPrefix } from './dispute.js';

export interface Marker {
  ts: string;
  kind: 'prompt' | 'first-failing-test' | 'loop' | 'context' | 'compaction' | 'ship' | 'edit' | 'receipt';
  text: string;
  cost_so_far: number;
}

export function buildReplay(t: Transcript, opts: { contextWindow: number; events?: ReturnType<typeof readEvents> }): Marker[] {
  const M: Marker[] = [];
  const costAt = (ts: string) => t.messages.filter((m) => m.ts <= ts).reduce((s, m) => s + m.cost, 0);
  for (const p of t.prompts) M.push({ ts: p.ts, kind: 'prompt', text: p.text.replace(/\s+/g, ' ').slice(0, 90), cost_so_far: costAt(p.ts) });
  let firstFail = false;
  const failStreak = new Map<string, number>();
  const loopsSeen = new Set<string>();
  let contextMarked = false;
  const editedFiles = new Set<string>();
  for (const c of t.toolCalls) {
    if (c.name === 'Bash') {
      const cmd = String(c.input.command ?? '');
      const isTest = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test|pytest|go test|cargo test|make test|vitest|jest\b/.test(cmd);
      if (c.result?.isError) {
        if (isTest && !firstFail) {
          firstFail = true;
          M.push({ ts: c.ts, kind: 'first-failing-test', text: cmd.slice(0, 80), cost_so_far: costAt(c.ts) });
        }
        const k = cmd.slice(0, 120);
        const n = (failStreak.get(k) ?? 0) + 1;
        failStreak.set(k, n);
        if (n === 3 && !loopsSeen.has(k)) {
          loopsSeen.add(k);
          M.push({ ts: c.ts, kind: 'loop', text: `3rd identical failure: ${cmd.slice(0, 70)}`, cost_so_far: costAt(c.ts) });
        }
      } else failStreak.delete(cmd.slice(0, 120));
    }
    if ((c.name === 'Edit' || c.name === 'Write' || c.name === 'MultiEdit') && typeof c.input.file_path === 'string') {
      const f = c.input.file_path.split(/[\\/]/).pop() ?? c.input.file_path;
      if (!editedFiles.has(f)) {
        editedFiles.add(f);
        M.push({ ts: c.ts, kind: 'edit', text: `first edit of ${f}`, cost_so_far: costAt(c.ts) });
      }
    }
  }
  for (const m of t.messages) {
    const used = m.usage.input + m.usage.cache_read + m.usage.cache_write;
    if (!contextMarked && used / opts.contextWindow >= 0.7) {
      contextMarked = true;
      M.push({ ts: m.ts, kind: 'context', text: `context passed 70% (${used.toLocaleString('en-US')} tokens)`, cost_so_far: costAt(m.ts) });
    }
  }
  for (const c of t.compactions) M.push({ ts: c.ts, kind: 'compaction', text: 'compaction', cost_so_far: costAt(c.ts) });
  for (const e of opts.events ?? []) if (e.type === 'ship') M.push({ ts: e.ts, kind: 'ship', text: `${String(e.data.kind)}${e.data.url ? ' ' + String(e.data.url) : ''}`, cost_so_far: costAt(e.ts) });
  return M.sort((a, b) => a.ts.localeCompare(b.ts));
}

const GLYPH: Record<Marker['kind'], string> = { prompt: '>', 'first-failing-test': '✘', loop: '⟳', context: '▓', compaction: '⌂', ship: '↑', edit: '✎', receipt: '⚖' };

export function renderReplay(session: string, markers: Marker[], opts: { title?: string; verdict?: string; total: number }): string {
  const L: string[] = [`Replay · ${session.slice(0, 8)}${opts.title ? ` · ${opts.title}` : ''} · ${fmtUsd(opts.total)} total`, ''];
  for (const m of markers) L.push(`${m.ts.slice(11, 19)}  ${fmtUsd(m.cost_so_far).padStart(8)}  ${GLYPH[m.kind]} ${m.kind.padEnd(18)} ${m.text}`);
  const loops = markers.filter((m) => m.kind === 'loop').length;
  const fail = markers.find((m) => m.kind === 'first-failing-test');
  L.push('');
  L.push(`Off-track moments: ${loops} loop(s)${fail ? `, first failing test at ${fail.ts.slice(11, 19)} (${fmtUsd(fail.cost_so_far)} in)` : ''}${markers.some((m) => m.kind === 'context') ? ', context pressure reached' : ''}${markers.filter((m) => m.kind === 'compaction').length ? `, ${markers.filter((m) => m.kind === 'compaction').length} compaction(s)` : ''}.`);
  if (opts.verdict) L.push(`Receipt: ${opts.verdict}`);
  return L.join('\n');
}

export async function run(args: Args): Promise<number | void> {
  const arg = args._[0];
  const session = arg ? resolveSessionPrefix(arg) : resolveSession(undefined, process.cwd());
  if (!session) {
    process.stderr.write('Usage: tally replay <session>\n');
    return 1;
  }
  const p = transcriptPathFor(session);
  if (!p) {
    process.stderr.write(`No transcript found for session ${session.slice(0, 8)}.\n`);
    return 1;
  }
  const t = parseTranscriptFile(p);
  const cfg = loadConfig();
  const markers = buildReplay(t, { contextWindow: t.contextTokensNow > cfg.context_window ? 1_000_000 : cfg.context_window, events: readEvents(session) });
  const j = loadJudge(session);
  if (j) markers.push({ ts: j.judged_at, kind: 'receipt', text: `${j.verdict.verdict} · ${j.completion_pct}% complete`, cost_so_far: t.cost });
  if (has(args, 'json')) process.stdout.write(JSON.stringify(markers, null, 2) + '\n');
  else process.stdout.write(renderReplay(session, markers, { title: loadTask(session)?.title, verdict: j?.verdict.verdict, total: t.cost }) + '\n');
}
