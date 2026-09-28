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

export class SessionNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionNotFound';
  }
}

/* every session id Tally knows: directories under ~/.tally/sessions plus the ids in active.json */
export function knownSessionIds(): string[] {
  const root = path.join(path.dirname(sessionDir('x')), '');
  const dirs = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => fs.statSync(path.join(root, d)).isDirectory()) : [];
  return [...new Set([...dirs, ...activeSessions().map((s) => s.id)])];
}

/* A session named on the command line: the full id, or any prefix that matches exactly one known session. The same
   rule for every command, so `verify cfe9bd83`, `judge cfe9bd83` and `status --session cfe9bd83` name the same thing.
   A prefix that matches nothing or several sessions is an error, never an empty session. */
export function resolveSessionId(given: string): string {
  const id = given.trim();
  if (!id) throw new SessionNotFound('empty session id');
  if (fs.existsSync(sessionDir(id))) return id;
  const known = knownSessionIds();
  if (known.includes(id)) return id;
  const hits = known.filter((s) => s.startsWith(id));
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) throw new SessionNotFound(`"${id}" matches ${hits.length} sessions (${hits.map((h) => h.slice(0, uniquePrefixLength(known))).join(', ')}); give more characters`);
  /* a full id that has no directory yet (a hook's first event is on its way): accept it, the caller will find nothing to read */
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return id;
  throw new SessionNotFound(`no session starting with "${id}" (tally sessions lists them)`);
}

/* the shortest prefix length (at least 8) that tells every known session apart */
export function uniquePrefixLength(ids: string[]): number {
  for (let n = 8; n < 36; n++) {
    const set = new Set(ids.map((s) => s.slice(0, n)));
    if (set.size === ids.length) return n;
  }
  return 36;
}

export function resolveSession(explicit?: string, cwd?: string): string | undefined {
  if (explicit) return resolveSessionId(explicit);
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

/* the directory the session ran in: the first recorded event's cwd, then active.json, then the frozen task's cwd */
export function sessionCwd(session: string): string | undefined {
  const events = readEvents(session);
  const fromEvents = events.find((e) => e.cwd)?.cwd;
  if (fromEvents) return fromEvents;
  const fromActive = activeSessions().find((s) => s.id === session)?.cwd;
  if (fromActive) return fromActive;
  const task = readJson<{ cwd?: string } | null>(path.join(sessionDir(session), 'task.json'), null);
  return task?.cwd;
}
