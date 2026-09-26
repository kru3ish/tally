import fs from 'node:fs';
import { sessionFromEnv } from './agents/index.js';
import path from 'node:path';
import { activeFile, readJson, projectTranscriptsDir, sessionDir } from './paths.js';
import { listSessions, readEvents } from './store/events.js';

export interface ActiveSession {
  id: string;
  cwd?: string;
  transcript_path?: string;
  model?: string;
  last_seen?: string;
}

export function activeSessions(): ActiveSession[] {
  const a = readJson<Record<string, Record<string, unknown>>>(activeFile(), {});
  return Object.entries(a)
    .map(([id, v]) => ({ id, cwd: v.cwd as string | undefined, transcript_path: v.transcript_path as string | undefined, model: v.model as string | undefined, last_seen: v.last_seen as string | undefined }))
    .sort((x, y) => (y.last_seen ?? '').localeCompare(x.last_seen ?? ''));
}

export function resolveSession(explicit?: string, cwd?: string): string | undefined {
  if (explicit) return explicit;
  const fromEnv = sessionFromEnv();
  if (fromEnv) return fromEnv;
  const active = activeSessions();
  const norm = (p?: string) => (p ?? '').replace(/\\/g, '/').toLowerCase();
  const byCwd = cwd ? active.find((s) => norm(s.cwd) === norm(cwd)) : undefined;
  if (byCwd) return byCwd.id;
  if (active[0]) return active[0].id;
  const all = listSessions();
  if (cwd) {
    for (const id of all) {
      const ev = readEvents(id);
      if (ev.some((e) => norm(e.cwd) === norm(cwd))) return id;
    }
  }
  return all[0];
}

export function transcriptPathFor(session: string): string | undefined {
  const events = readEvents(session);
  for (const e of events) {
    const p = e.data.transcript_path;
    if (typeof p === 'string' && fs.existsSync(p)) return p;
  }
  const active = activeSessions().find((s) => s.id === session);
  if (active?.transcript_path && fs.existsSync(active.transcript_path)) return active.transcript_path;
  const cwd = events.find((e) => e.cwd)?.cwd;
  if (cwd) {
    const candidate = path.join(projectTranscriptsDir(cwd), `${session}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  const local = path.join(sessionDir(session), 'transcript.jsonl');
  if (fs.existsSync(local)) return local;
  return undefined;
}

export function sessionCwd(session: string): string | undefined {
  const events = readEvents(session);
  return events.find((e) => e.cwd)?.cwd ?? activeSessions().find((s) => s.id === session)?.cwd;
}
