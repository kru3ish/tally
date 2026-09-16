import fs from 'node:fs';
import { setTestRerunConsent, type Config } from '../config.js';
import { EventTail, eventsFile, readEvents } from '../store/events.js';
import { parseTranscriptFile, type Transcript } from '../transcript/parse.js';
import { fmtUsd } from '../cost/pricing.js';
import { buildContext } from './context.js';
import { CoachEngine, loadState, saveState, muteRule } from './engine.js';
import { applySuggestion, injectSuggestion, skipSuggestion } from './actions.js';
import { llmCoach } from './llm-coach.js';
import type { LlmClient } from '../llm/client.js';
import type { Suggestion, RuleContext } from './types.js';
import { transcriptPathFor } from '../session.js';
import { loadTask, intake, confirmTask } from '../task/intake.js';
import { makeLlm } from '../llm/client.js';
import readline from 'node:readline';

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

export function paint(color: boolean, code: string, s: string): string {
  return color ? `${code}${s}${C.reset}` : s;
}

export function renderHeader(ctx: RuleContext, color = true): string {
  const task = ctx.task;
  const pct = ctx.contextWindow ? Math.round((ctx.contextTokensNow / ctx.contextWindow) * 100) : 0;
  const budget = task?.budget_usd ?? 0;
  const spendStr = budget ? `${fmtUsd(ctx.spendUsd)} / ${fmtUsd(budget)} (${Math.round((ctx.spendUsd / budget) * 100)}%)` : fmtUsd(ctx.spendUsd);
  const lines = [
    paint(color, C.bold, `Tally Coach`) + paint(color, C.gray, `  session ${ctx.session.slice(0, 8)}  ${ctx.cwd}`),
    `${paint(color, C.cyan, 'task')}  ${task ? `${task.title}  ${paint(color, C.gray, `spec ${task.spec_quality.score}/10, ${task.criteria.length} criteria`)}` : paint(color, C.yellow, 'none linked (tally task <url|path|text>)')}`,
    `${paint(color, C.cyan, 'spend')} ${spendStr} API-equivalent   ${paint(color, C.cyan, 'context')} ${pct}%   ${paint(color, C.cyan, 'tools')} ${ctx.events.filter((e) => e.type === 'post_tool').length}`,
  ];
  return lines.join('\n');
}

export function renderSuggestion(s: Suggestion, color = true, index?: number): string {
  const sev = s.severity === 'critical' ? paint(color, C.red, '!! ') : s.severity === 'warn' ? paint(color, C.yellow, ' ! ') : paint(color, C.blue, ' · ');
  const saved = s.usd_saved > 0 ? paint(color, C.gray, `  ~${fmtUsd(s.usd_saved)} at stake`) : '';
  const head = `${sev}${paint(color, C.bold, s.title)}${saved}${index !== undefined ? paint(color, C.gray, `  #${index}`) : ''}`;
  const body = s.message
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
  const act = s.action.kind === 'none' ? '' : `\n    ${paint(color, C.gray, `[a]pply: ${s.action.label}`)}`;
  const keys = s.action.kind === 'confirm' ? '[c]onfirm  [e]dit  [l]ink  [s]kip' : '[a]pply  [i]nject  [s]kip  [m]ute rule';
  return `${head}\n${body}${act}\n    ${paint(color, C.gray, keys)}`;
}

export interface WatchOptions {
  session: string;
  cwd: string;
  cfg: Config;
  llm?: LlmClient;
  color?: boolean;
  once?: boolean;
  pollMs?: number;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  maxTicks?: number;
  now?: () => Date;
}

export async function watch(opts: WatchOptions): Promise<void> {
  const out = opts.output ?? process.stdout;
  const color = opts.color ?? !!out.isTTY;
  const w = (s: string) => out.write(s + '\n');
  const engine = new CoachEngine(loadState(opts.session), opts.cfg);
  const tail = new EventTail(eventsFile(opts.session));
  let events = readEvents(opts.session);
  tail.poll();
  let transcript: Transcript | undefined;
  let transcriptSize = -1;
  let transcriptPath = transcriptPathFor(opts.session);
  let pending: Suggestion[] = [];
  let ticks = 0;
  const mode = opts.cfg.auto_apply;

  const refreshTranscript = () => {
    transcriptPath ??= transcriptPathFor(opts.session);
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return;
    const size = fs.statSync(transcriptPath).size;
    if (size === transcriptSize) return;
    transcriptSize = size;
    try {
      transcript = parseTranscriptFile(transcriptPath);
    } catch {
      /* torn write; retry next tick */
    }
  };

  const makeCtx = () => buildContext({ session: opts.session, cwd: opts.cwd, cfg: opts.cfg, events, transcript, now: opts.now?.() });

  const readLine = (question: string): Promise<string> =>
    new Promise((resolve) => {
      const inp = opts.input ?? process.stdin;
      if (!inp.isTTY) return resolve('');
      const rl = readline.createInterface({ input: inp, output: out });
      rl.question(question, (a) => {
        rl.close();
        resolve(a.trim());
      });
    });

  const handle = async (s: Suggestion, key: string, ctx: RuleContext) => {
    if (s.action.kind === 'confirm' && (key === 'c' || key === 'a')) {
      const r = applySuggestion(s, { session: opts.session, cwd: opts.cwd, cfg: opts.cfg, mode: 'ask' });
      w(paint(color, r.ok ? C.green : C.red, `    → ${r.detail}`));
      saveState(opts.session, engine.state);
      return;
    }
    if (s.action.kind === 'confirm' && (key === 'e' || key === 'l')) {
      const answer = await readLine(key === 'e' ? '    Describe the task in your words: ' : '    Ticket URL: ');
      if (!answer) {
        w(paint(color, C.gray, '    → nothing entered; task left unconfirmed'));
        return;
      }
      const r = await intake({ session: opts.session, cwd: opts.cwd, ref: key === 'l' ? answer : undefined, text: key === 'e' ? answer : undefined, cfg: opts.cfg, llm: opts.llm ?? makeLlm({ session: opts.session }), force: true });
      if (key === 'e') confirmTask(opts.session);
      w(paint(color, C.green, `    → task ${key === 'l' ? 'linked' : 'rewritten and confirmed'}: "${r.task.title}" (${r.task.criteria.length} criteria)`));
      saveState(opts.session, engine.state);
      return;
    }
    if (key === 'a') {
      const r = applySuggestion(s, { session: opts.session, cwd: opts.cwd, cfg: opts.cfg, mode: 'ask' });
      w(paint(color, r.ok ? C.green : C.red, `    → ${r.ok ? 'applied' : 'not applied'}: ${r.detail}`));
    } else if (key === 'i') {
      const r = injectSuggestion(s, { session: opts.session, cwd: opts.cwd });
      w(paint(color, C.green, `    → ${r.detail}`));
    } else if (key === 's') {
      skipSuggestion(s, { session: opts.session, cwd: opts.cwd });
      const r = engine.recordSkip(opts.cwd, s.rule);
      w(paint(color, C.gray, `    → skipped${r.muted ? ` (rule ${s.rule} muted for this repo after ${r.skips} skips)` : ''}`));
    } else if (key === 'm') {
      if (s.action.kind === 'consent') setTestRerunConsent(opts.cwd, false);
      muteRule(opts.cwd, s.rule, 'muted by user');
      w(paint(color, C.gray, `    → rule ${s.rule} muted for this repo (tally config unmute ${s.rule})`));
    }
    saveState(opts.session, engine.state);
    void ctx;
  };

  const readKey = (): Promise<string> =>
    new Promise((resolve) => {
      const inp = opts.input ?? process.stdin;
      if (!inp.isTTY) {
        resolve('');
        return;
      }
      inp.setRawMode?.(true);
      inp.resume();
      const onData = (d: Buffer) => {
        inp.off('data', onData);
        inp.setRawMode?.(false);
        inp.pause();
        const k = d.toString('utf8');
        if (k === '' || k === 'q') {
          w('');
          process.exit(0);
        }
        resolve(k.toLowerCase());
      };
      inp.on('data', onData);
    });

  refreshTranscript();
  let ctx = makeCtx();
  w(renderHeader(ctx, color));
  w(paint(color, C.gray, `mode: ${mode} · rules: deterministic first, LLM (${opts.cfg.models.coach}) at most every ${opts.cfg.coach.llm_interval_s}s once the session passes $${opts.cfg.coach.llm_min_session_usd} · q to quit`));
  w('');

  for (;;) {
    ticks += 1;
    const fresh = tail.poll();
    if (fresh.length) events = events.concat(fresh);
    refreshTranscript();
    ctx = makeCtx();
    const result = engine.tick(ctx);
    let shown = result.show;
    /* the LLM pass is off below coach.llm_min_session_usd (default $1): small sessions get the deterministic rules only */
    if (opts.llm && ctx.spendUsd >= opts.cfg.coach.llm_min_session_usd && engine.llmAllowed(ctx.now, events.length) && !shown.length && events.some((e) => e.type === 'post_tool')) {
      engine.markLlm(ctx.now, events.length);
      try {
        const s = await llmCoach(ctx, opts.llm);
        if (s) shown = engine.tick(ctx, [s]).show;
      } catch (err) {
        w(paint(color, C.gray, `    (coach llm unavailable: ${String(err).slice(0, 80)})`));
      }
    }
    for (const s of shown) {
      pending.push(s);
      w(renderSuggestion(s, color));
      if (mode === 'auto' && (s.action.kind === 'write_md' || s.action.kind === 'inject')) {
        const r = applySuggestion(s, { session: opts.session, cwd: opts.cwd, cfg: opts.cfg, mode: 'auto' });
        w(paint(color, r.ok ? C.green : C.red, `    → auto-applied: ${r.detail}`));
        pending = pending.filter((p) => p !== s);
        continue;
      }
      if (mode === 'off') {
        pending = pending.filter((p) => p !== s);
        continue;
      }
      if (opts.once) continue;
      const key = await readKey();
      if (key) await handle(s, key, ctx);
      pending = pending.filter((p) => p !== s);
      w('');
    }
    saveState(opts.session, engine.state);
    if (events.some((e) => e.type === 'session_end') && ticks > 1) {
      w(paint(color, C.gray, 'session ended; the receipt will appear via `tally judge` shortly.'));
      return;
    }
    if (opts.once || (opts.maxTicks && ticks >= opts.maxTicks)) return;
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 1500));
  }
}

export function statusLine(session: string, cwd: string, cfg: Config, color = false): string {
  const ctx = buildContext({ session, cwd, cfg, transcriptPath: transcriptPathFor(session) });
  const task = loadTask(session);
  return renderHeader({ ...ctx, task }, color);
}
