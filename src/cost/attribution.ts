import type { Transcript } from '../transcript/parse.js';

export interface AttributionRow {
  kind: 'skill' | 'mcp';
  name: string;
  invocations: number;
  errors: number;
  tokens: number;
  usd: number;
  turns: number[];
  touched_met_criteria: boolean | null;
}

export function attribute(t: Transcript): AttributionRow[] {
  const rows = new Map<string, AttributionRow>();
  const add = (kind: 'skill' | 'mcp', name: string, messageId: string, turn: number, isError: boolean) => {
    const key = `${kind}:${name}`;
    const row = rows.get(key) ?? { kind, name, invocations: 0, errors: 0, tokens: 0, usd: 0, turns: [], touched_met_criteria: null };
    row.invocations += 1;
    if (isError) row.errors += 1;
    const msg = t.messages.find((m) => m.id === messageId);
    const call = t.toolCalls.find((c) => c.messageId === messageId && (kind === 'skill' ? c.name === 'Skill' : c.name === `mcp__${name.replace(':', '__')}`));
    const resultTokens = Math.round((call?.result?.chars ?? 0) / 4);
    row.tokens += (msg?.usage.output ?? 0) + resultTokens;
    row.usd += msg?.cost ?? 0;
    if (!row.turns.includes(turn)) row.turns.push(turn);
    rows.set(key, row);
  };
  for (const s of t.skills) add('skill', s.name, s.messageId, s.turn, false);
  for (const m of t.mcpCalls) add('mcp', `${m.server}:${m.tool}`, m.messageId, m.turn, m.isError);
  return [...rows.values()].sort((a, b) => b.usd - a.usd);
}

export function markTouched(rows: AttributionRow[], t: Transcript, metFiles: string[]): AttributionRow[] {
  const norm = (f: string) => f.replace(/\\/g, '/').toLowerCase();
  const met = new Set(metFiles.map(norm));
  const editTurns = new Set<number>();
  for (const c of t.toolCalls) {
    if (!['Edit', 'Write', 'MultiEdit'].includes(c.name)) continue;
    const f = typeof c.input.file_path === 'string' ? norm(c.input.file_path) : '';
    if ([...met].some((m) => f.endsWith(m) || m.endsWith(f))) editTurns.add(c.turn);
  }
  return rows.map((r) => ({ ...r, touched_met_criteria: met.size === 0 ? null : r.turns.some((turn) => editTurns.has(turn)) }));
}
