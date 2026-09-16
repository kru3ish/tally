import fs from 'node:fs';
import type { Config } from '../config.js';
import { historyFile } from '../paths.js';
import { readEvents, type TallyEvent } from '../store/events.js';
import { parseTranscriptFile, type Transcript } from '../transcript/parse.js';
import { loadTask } from '../task/intake.js';
import { isModel1M } from '../cost/pricing.js';
import { readClaudeMd } from './engine.js';
import type { HistoryEntry, RuleContext } from './types.js';

export function loadHistory(): HistoryEntry[] {
  const f = historyFile();
  if (!fs.existsSync(f)) return [];
  const out: HistoryEntry[] = [];
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as HistoryEntry);
    } catch {
      /* skip */
    }
  }
  return out;
}

export function buildContext(opts: { session: string; cwd: string; cfg: Config; now?: Date; events?: TallyEvent[]; transcript?: Transcript; transcriptPath?: string; history?: HistoryEntry[] }): RuleContext {
  const events = opts.events ?? readEvents(opts.session);
  let transcript = opts.transcript;
  if (!transcript && opts.transcriptPath && fs.existsSync(opts.transcriptPath)) {
    try {
      transcript = parseTranscriptFile(opts.transcriptPath);
    } catch {
      transcript = undefined;
    }
  }
  const startEv = events.find((e) => e.type === 'session_start');
  const loaded = (startEv?.data.loaded as RuleContext['loaded'] | undefined) ?? { mcp: [], skills: [], plugins: [] };
  const mainMsgs = transcript?.messages.filter((m) => m.agent === 'main') ?? [];
  const avgTurnCostUsd = mainMsgs.length ? mainMsgs.reduce((s, m) => s + m.cost, 0) / mainMsgs.length : 0.15;
  const model = String(startEv?.data.model ?? mainMsgs[0]?.model ?? '');
  const contextWindow = isModel1M(model) ? 1_000_000 : opts.cfg.context_window;
  const lastTs = events.at(-1)?.ts ?? transcript?.endedAt;
  return {
    session: opts.session,
    cwd: opts.cwd,
    now: opts.now ?? (lastTs ? new Date(Math.max(Date.parse(lastTs), Date.now() - 365 * 24 * 3600 * 1000)) : new Date()),
    cfg: opts.cfg,
    events,
    transcript,
    task: loadTask(opts.session),
    history: opts.history ?? loadHistory(),
    claudeMd: readClaudeMd(opts.cwd),
    avgTurnCostUsd,
    contextTokensNow: transcript?.contextTokensNow ?? 0,
    contextWindow,
    spendUsd: transcript?.cost ?? 0,
    loaded,
  };
}
