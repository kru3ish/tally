import type { Transcript, ToolCall } from '../transcript/parse.js';
import { loadPricing, priceFor, type Pricing } from './pricing.js';

export interface WasteItem {
  kind: 'failed_loop' | 'repeated_read' | 'dead_weight' | 'compaction_churn';
  usd: number;
  count: number;
  detail: string;
}

export interface WasteReport {
  items: WasteItem[];
  total_usd: number;
  failed_loops: Array<{ command: string; repeats: number; usd: number }>;
  repeated_reads: Array<{ file: string; reads: number; usd: number }>;
  dead_weight: { first_turn_tokens: number; baseline_tokens: number; overhead_tokens: number; usd: number };
  compaction_churn: { compactions: number; recache_tokens: number; usd: number };
}

function msgCost(t: Transcript, messageId: string): number {
  return t.messages.find((m) => m.id === messageId)?.cost ?? 0;
}

function tokensOf(chars: number): number {
  return Math.round(chars / 4);
}

export function normalizeCommand(cmd: string): string {
  return cmd.replace(/\s+/g, ' ').trim();
}

export function findFailedLoops(calls: ToolCall[]): Array<{ command: string; repeats: number; callIds: string[] }> {
  const out: Array<{ command: string; repeats: number; callIds: string[] }> = [];
  const byCmd = new Map<string, string[]>();
  for (const c of calls) {
    if (c.agent !== 'main' || c.name !== 'Bash') continue;
    const cmd = typeof c.input.command === 'string' ? normalizeCommand(c.input.command) : '';
    if (!cmd || !c.result?.isError) continue;
    const arr = byCmd.get(cmd) ?? [];
    arr.push(c.id);
    byCmd.set(cmd, arr);
  }
  for (const [command, ids] of byCmd) if (ids.length >= 2) out.push({ command, repeats: ids.length, callIds: ids });
  return out.sort((a, b) => b.repeats - a.repeats);
}

export function findRepeatedReads(calls: ToolCall[], min = 3): Array<{ file: string; reads: number; callIds: string[] }> {
  const byFile = new Map<string, string[]>();
  for (const c of calls) {
    if (c.name !== 'Read' || c.agent !== 'main') continue;
    const f = typeof c.input.file_path === 'string' ? c.input.file_path.replace(/\\/g, '/') : '';
    if (!f) continue;
    const arr = byFile.get(f) ?? [];
    arr.push(c.id);
    byFile.set(f, arr);
  }
  const out: Array<{ file: string; reads: number; callIds: string[] }> = [];
  for (const [file, ids] of byFile) if (ids.length >= min) out.push({ file, reads: ids.length, callIds: ids });
  return out.sort((a, b) => b.reads - a.reads);
}

export function computeWaste(t: Transcript, opts: { baselineTokens: number; pricing?: Pricing }): WasteReport {
  const pricing = opts.pricing ?? loadPricing();
  const mainModel = t.messages.find((m) => m.agent === 'main')?.model;
  const price = priceFor(mainModel, pricing);
  const items: WasteItem[] = [];

  const failed_loops = findFailedLoops(t.toolCalls).map((l) => {
    const usd = l.callIds.slice(1).reduce((s, id) => {
      const call = t.toolCalls.find((c) => c.id === id);
      return s + (call ? msgCost(t, call.messageId) + (tokensOf(call.result?.chars ?? 0) * price.input) / 1e6 : 0);
    }, 0);
    return { command: l.command, repeats: l.repeats, usd };
  });
  const loopUsd = failed_loops.reduce((s, x) => s + x.usd, 0);
  items.push({ kind: 'failed_loop', usd: loopUsd, count: failed_loops.length, detail: failed_loops.map((l) => `${l.command} ×${l.repeats}`).join('; ') });

  const repeated_reads = findRepeatedReads(t.toolCalls).map((r) => {
    const usd = r.callIds.slice(1).reduce((s, id) => {
      const call = t.toolCalls.find((c) => c.id === id);
      return s + (call ? msgCost(t, call.messageId) + (tokensOf(call.result?.chars ?? 0) * price.input) / 1e6 : 0);
    }, 0);
    return { file: r.file, reads: r.reads, usd };
  });
  const readUsd = repeated_reads.reduce((s, x) => s + x.usd, 0);
  items.push({ kind: 'repeated_read', usd: readUsd, count: repeated_reads.length, detail: repeated_reads.map((r) => `${r.file} ×${r.reads}`).join('; ') });

  const overhead = Math.max(0, t.firstTurnContextTokens - opts.baselineTokens);
  const mainMsgs = t.messages.filter((m) => m.agent === 'main').length;
  const deadUsd = (overhead * price.cache_write_1h + overhead * price.cache_read * Math.max(0, mainMsgs - 1)) / 1e6;
  items.push({
    kind: 'dead_weight',
    usd: deadUsd,
    count: overhead > 0 ? 1 : 0,
    detail: `first turn loaded ${t.firstTurnContextTokens} tokens (${overhead} above the ${opts.baselineTokens} baseline), re-read on ${mainMsgs} calls`,
  });

  const recache = t.messages.filter((m) => m.afterCompaction).reduce((s, m) => s + m.usage.cache_write, 0);
  const churnUsd = (recache * price.cache_write_1h) / 1e6;
  items.push({ kind: 'compaction_churn', usd: churnUsd, count: t.compactions.length, detail: `${t.compactions.length} compaction(s), ${recache} tokens re-cached` });

  return {
    items,
    total_usd: items.reduce((s, i) => s + i.usd, 0),
    failed_loops,
    repeated_reads,
    dead_weight: { first_turn_tokens: t.firstTurnContextTokens, baseline_tokens: opts.baselineTokens, overhead_tokens: overhead, usd: deadUsd },
    compaction_churn: { compactions: t.compactions.length, recache_tokens: recache, usd: churnUsd },
  };
}
