import fs from 'node:fs';
import path from 'node:path';
import { undoLog, appendLine, ensureDir } from '../paths.js';

export interface UndoEntry {
  id: string;
  ts: string;
  session: string;
  rule: string;
  label: string;
  file: string;
  before: string | null;
  after: string;
  undone?: boolean;
}

export function recordChange(entry: Omit<UndoEntry, 'id' | 'ts'>): UndoEntry {
  const e: UndoEntry = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, ts: new Date().toISOString(), ...entry };
  appendLine(undoLog(), JSON.stringify(e));
  return e;
}

export function readUndoLog(): UndoEntry[] {
  const f = undoLog();
  if (!fs.existsSync(f)) return [];
  const byId = new Map<string, UndoEntry>();
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as UndoEntry & { undone_marker?: string };
      if (e.undone_marker) {
        const t = byId.get(e.undone_marker);
        if (t) t.undone = true;
      } else byId.set(e.id, e);
    } catch {
      /* skip */
    }
  }
  return [...byId.values()];
}

export function undoLast(n = 1): UndoEntry[] {
  const entries = readUndoLog().filter((e) => !e.undone).reverse().slice(0, n);
  const done: UndoEntry[] = [];
  for (const e of entries) {
    const current = fs.existsSync(e.file) ? fs.readFileSync(e.file, 'utf8') : null;
    if (current !== e.after) {
      /* file changed since; still restore but keep a copy so nothing is lost */
      if (current !== null) fs.writeFileSync(e.file + `.tally-undo-${e.id}.bak`, current);
    }
    if (e.before === null) {
      if (fs.existsSync(e.file)) fs.unlinkSync(e.file);
    } else {
      ensureDir(path.dirname(e.file));
      fs.writeFileSync(e.file, e.before);
    }
    appendLine(undoLog(), JSON.stringify({ undone_marker: e.id, ts: new Date().toISOString() }));
    done.push({ ...e, undone: true });
  }
  return done;
}
