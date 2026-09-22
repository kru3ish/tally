import fs from 'node:fs';
import path from 'node:path';
import { sessionDir, sessionsDir, ensureDir, appendLine } from '../paths.js';

export type EventType =
  | 'session_start'
  | 'prompt'
  | 'pre_tool'
  | 'post_tool'
  | 'stop'
  | 'pre_compact'
  | 'session_end'
  | 'ship'
  | 'task'
  | 'coach'
  | 'inject'
  | 'apply'
  | 'skip'
  | 'mute'
  | 'judge'
  | 'permission'
  | 'note' | 'budget_approved' | 'hard_stop_denied' | 'dispute';

export interface TallyEvent {
  ts: string;
  type: EventType;
  session: string;
  cwd?: string;
  data: Record<string, unknown>;
}

export function eventsFile(sessionId: string): string {
  return path.join(sessionDir(sessionId), 'events.jsonl');
}

export function appendEvent(ev: TallyEvent): void {
  appendLine(eventsFile(ev.session), JSON.stringify(ev));
}

export function readEvents(sessionId: string): TallyEvent[] {
  return readEventsFile(eventsFile(sessionId));
}

export function readEventsFile(file: string): TallyEvent[] {
  if (!fs.existsSync(file)) return [];
  const out: TallyEvent[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as TallyEvent);
    } catch {
      /* skip torn line */
    }
  }
  return out;
}

export class EventTail {
  private offset = 0;
  constructor(private readonly file: string) {}

  poll(): TallyEvent[] {
    if (!fs.existsSync(this.file)) return [];
    const size = fs.statSync(this.file).size;
    if (size <= this.offset) return [];
    const fd = fs.openSync(this.file, 'r');
    try {
      const buf = Buffer.alloc(size - this.offset);
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      const text = buf.toString('utf8');
      const lastNl = text.lastIndexOf('\n');
      if (lastNl < 0) return [];
      this.offset += Buffer.byteLength(text.slice(0, lastNl + 1));
      const out: TallyEvent[] = [];
      for (const line of text.slice(0, lastNl).split('\n')) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as TallyEvent);
        } catch {
          /* skip */
        }
      }
      return out;
    } finally {
      fs.closeSync(fd);
    }
  }
}

export function listSessions(): string[] {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((d) => fs.existsSync(path.join(dir, d, 'events.jsonl')))
    .map((d) => ({ d, m: fs.statSync(path.join(dir, d, 'events.jsonl')).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .map((x) => x.d);
}

export function ensureSession(sessionId: string): string {
  const dir = sessionDir(sessionId);
  ensureDir(dir);
  return dir;
}
