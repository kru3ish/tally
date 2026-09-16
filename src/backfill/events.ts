/* Past sessions have no hook events, so they are synthesised from the transcript; the Coach rules then replay over them. */
import { isShipCommand, type Transcript } from '../transcript/parse.js';
import type { TallyEvent } from '../store/events.js';
import type { Config } from '../config.js';
import { CoachEngine } from '../coach/engine.js';
import { buildContext } from '../coach/context.js';
import type { HistoryEntry, Suggestion } from '../coach/types.js';
import { redact } from '../redact.js';

export function eventsFromTranscript(t: Transcript, session: string, cwd: string, transcriptPath: string, gitHead?: string): TallyEvent[] {
  const ev: TallyEvent[] = [];
  const push = (ts: string, type: TallyEvent['type'], data: Record<string, unknown>) => ev.push({ ts, type, session, cwd, data });
  const start = t.startedAt ?? new Date(0).toISOString();
  const end = t.endedAt ?? start;
  const mcp = [...new Set(t.mcpCalls.map((m) => m.server))];
  const skills = [...new Set(t.skills.map((s) => s.name))];
  push(start, 'session_start', { source: 'backfill', model: t.models[0], transcript_path: transcriptPath, git_head: gitHead, loaded: { mcp, skills, plugins: [] }, synthesized: true });
  for (const p of t.prompts) push(p.ts, 'prompt', { prompt: redact(p.text.slice(0, 2000)), chars: p.text.length, turn: p.turn });
  for (const c of t.toolCalls) {
    if (c.agent !== 'main') continue;
    const input: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c.input)) input[k] = typeof v === 'string' ? redact(v.slice(0, 600)) : v;
    push(c.ts, 'pre_tool', { tool_name: c.name, tool_input: input, tool_use_id: c.id, agent: null });
    const text = c.result?.text ?? '';
    push(c.ts, 'post_tool', { tool_name: c.name, tool_input: input, tool_use_id: c.id, is_error: !!c.result?.isError, response_chars: c.result?.chars ?? 0, response_head: redact(text.slice(0, 600)), agent: null });
    const cmd = typeof c.input.command === 'string' ? c.input.command : '';
    if (c.name === 'Bash' && cmd && isShipCommand(cmd) && !c.result?.isError) {
      const kind = /gh\s+pr\s+create/.test(cmd) ? 'pr' : /gh\s+pr\s+merge/.test(cmd) ? 'merge' : /publish|upload/.test(cmd) ? 'publish' : 'push';
      const url = /https?:\/\/\S+/.exec(text)?.[0];
      push(c.ts, 'ship', { kind, command: redact(cmd), url });
    }
  }
  for (const c of t.compactions) push(c.ts, 'pre_compact', { trigger: 'auto' });
  if (t.finalAssistantText) push(end, 'stop', { last_assistant_message: redact(t.finalAssistantText.slice(0, 800)) });
  push(end, 'session_end', { reason: 'backfill', transcript_path: transcriptPath });
  return ev.sort((a, b) => a.ts.localeCompare(b.ts));
}

export interface ReplayedSuggestion {
  ts: string;
  rule: string;
  key: string;
  severity: Suggestion['severity'];
  title: string;
  message: string;
  usd_saved: number;
  action: string;
}

export interface CoachReplay {
  session: string;
  replayed_at: string;
  events: number;
  shown: ReplayedSuggestion[];
  held: number;
  note: string;
}

/* Runs the deterministic rules over the synthesised events with simulated time and the normal noise limits.
   Spend and context size are recomputed from the transcript prefix at each tick. The LLM pass is never replayed. */
export function replayCoach(opts: { session: string; cwd: string; cfg: Config; events: TallyEvent[]; transcript: Transcript; history?: HistoryEntry[] }): CoachReplay {
  const engine = new CoachEngine({ shown: 0, shown_keys: [], skips: {}, llm_events_seen: 0 }, opts.cfg, undefined, {});
  const base = buildContext({ session: opts.session, cwd: opts.cwd, cfg: opts.cfg, events: [], transcript: opts.transcript, history: opts.history ?? [] });
  const shown: ReplayedSuggestion[] = [];
  let held = 0;
  const mains = opts.transcript.messages.filter((m) => m.agent === 'main');
  for (let i = 0; i < opts.events.length; i++) {
    const now = new Date(opts.events[i]!.ts);
    const upTo = opts.events.slice(0, i + 1);
    const prefix = mains.filter((m) => Date.parse(m.ts) <= now.getTime());
    const last = prefix.at(-1);
    const ctx = { ...base, now, events: upTo, spendUsd: prefix.reduce((s, m) => s + m.cost, 0), contextTokensNow: last ? last.usage.input + last.usage.cache_read + last.usage.cache_write : 0 };
    const r = engine.tick(ctx);
    held += r.held.length;
    for (const s of r.show) shown.push({ ts: now.toISOString(), rule: s.rule, key: s.key, severity: s.severity, title: s.title, message: s.message, usd_saved: Math.round(s.usd_saved * 1000) / 1000, action: s.action.kind });
  }
  return { session: opts.session, replayed_at: new Date().toISOString(), events: opts.events.length, shown, held, note: 'deterministic rules only, replayed with the session timestamps and the normal noise limits; the LLM coach pass is not replayed' };
}
