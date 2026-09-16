import type { TallyEvent } from '../store/events.js';
import type { RuleContext } from './types.js';

export function norm(cmd: unknown): string {
  return typeof cmd === 'string' ? cmd.replace(/\s+/g, ' ').trim() : '';
}

export function normPath(p: unknown): string {
  return typeof p === 'string' ? p.replace(/\\/g, '/').toLowerCase() : '';
}

export function postTools(ctx: RuleContext): TallyEvent[] {
  return ctx.events.filter((e) => e.type === 'post_tool' && !e.data.agent);
}

export function toolName(e: TallyEvent): string {
  return String(e.data.tool_name ?? '');
}

export function toolInput(e: TallyEvent): Record<string, unknown> {
  return (e.data.tool_input ?? {}) as Record<string, unknown>;
}

export function minutesAgo(ctx: RuleContext, minutes: number): string {
  return new Date(ctx.now.getTime() - minutes * 60000).toISOString();
}

export function countBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const i of items) {
    const k = key(i);
    if (!k) continue;
    const arr = m.get(k) ?? [];
    arr.push(i);
    m.set(k, arr);
  }
  return m;
}

export function shortPath(p: string, cwd?: string): string {
  const n = p.replace(/\\/g, '/');
  if (cwd) {
    const c = cwd.replace(/\\/g, '/').replace(/\/$/, '') + '/';
    if (n.toLowerCase().startsWith(c.toLowerCase())) return n.slice(c.length);
  }
  return n.length > 60 ? '…' + n.slice(-57) : n;
}

export function usd(n: number): string {
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
}
