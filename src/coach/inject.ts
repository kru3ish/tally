import fs from 'node:fs';
import path from 'node:path';
import { sessionDir, ensureDir, appendLine } from '../paths.js';
import { appendEvent } from '../store/events.js';

export interface InjectItem {
  ts: string;
  note: string;
  source: string;
  delivered?: boolean;
  delivered_at?: string;
}

export function injectFile(session: string): string {
  return path.join(sessionDir(session), 'inject.jsonl');
}

export function enqueueInject(session: string, note: string, source: string, cwd?: string): InjectItem {
  ensureDir(sessionDir(session));
  const item: InjectItem = { ts: new Date().toISOString(), note: note.trim(), source };
  appendLine(injectFile(session), JSON.stringify(item));
  appendEvent({ ts: item.ts, type: 'inject', session, cwd, data: { source, note: item.note.slice(0, 300) } });
  return item;
}

export function readInjects(session: string): InjectItem[] {
  const f = injectFile(session);
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as InjectItem;
      } catch {
        return null;
      }
    })
    .filter((x): x is InjectItem => !!x);
}

export function pendingInjects(session: string): InjectItem[] {
  return readInjects(session).filter((i) => !i.delivered);
}
